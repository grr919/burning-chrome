type AsnRecord = {
  ipAddress: string;
  asn?: string;
  asnName?: string;
  route?: string;
  country?: string;
  registry?: string;
  source?: string;
  error?: string;
};

type VercelRequest = {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
};

type VercelResponse = {
  setHeader?: (name: string, value: string | string[]) => void;
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

type GoogleDnsAnswer = {
  data?: string;
};

type GoogleDnsResponse = {
  Status?: number;
  Answer?: GoogleDnsAnswer[];
  Comment?: string;
};

const MAX_IPS_PER_REQUEST = 256;

function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  const parts = text.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });

  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets.join('.');
}

function isPrivateOrReserved(ipAddress: string): boolean {
  const [first, second] = ipAddress.split('.').map((part) => Number.parseInt(part, 10));

  if (first === 0) return true;
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first >= 224) return true;

  return false;
}

function normalizeRequestBody(body: unknown): Record<string, unknown> {
  if (!body) {
    return {};
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  if (typeof body === 'object') {
    return body as Record<string, unknown>;
  }

  return {};
}

function extractIpAddresses(req: VercelRequest): string[] {
  const body = normalizeRequestBody(req.body);
  const bodyIps = body.ipAddresses;
  const bodyIp = body.ip;
  const queryIp = req.query?.ip;

  const rawValues: unknown[] = [];

  if (Array.isArray(bodyIps)) {
    rawValues.push(...bodyIps);
  }

  if (bodyIp) {
    rawValues.push(bodyIp);
  }

  if (Array.isArray(queryIp)) {
    rawValues.push(...queryIp);
  } else if (queryIp) {
    rawValues.push(queryIp);
  }

  const normalized = rawValues
    .map((value) => normalizeIp(value))
    .filter((value): value is string => Boolean(value));

  return [...new Set(normalized)].slice(0, MAX_IPS_PER_REQUEST);
}

function cleanTxtRecord(value: string): string {
  return value
    .replace(/^"+|"+$/g, '')
    .replace(/\\"/g, '"')
    .trim();
}

function parseTeamCymruRecord(ipAddress: string, txtRecord: string): AsnRecord {
  const clean = cleanTxtRecord(txtRecord);
  const parts = clean.split('|').map((part) => part.trim());

  const [asnRaw, route, country, registry, , ...nameParts] = parts;
  const asn = asnRaw && asnRaw !== 'NA' ? `AS${asnRaw.replace(/^AS/i, '')}` : undefined;
  const asnName = nameParts.join(' | ').trim() || undefined;

  if (!asn) {
    return {
      ipAddress,
      source: 'team-cymru-google-doh',
      error: `Team Cymru returned no ASN for ${ipAddress}.`,
    };
  }

  return {
    ipAddress,
    asn,
    asnName,
    route: route || undefined,
    country: country || undefined,
    registry: registry || undefined,
    source: 'team-cymru-google-doh',
  };
}

async function lookupAsn(ipAddress: string): Promise<AsnRecord> {
  if (isPrivateOrReserved(ipAddress)) {
    return {
      ipAddress,
      source: 'local-validation',
      error: 'Private, multicast, or reserved IP address; no public ASN is expected.',
    };
  }

  const reversed = ipAddress.split('.').reverse().join('.');
  const name = `${reversed}.origin.asn.cymru.com`;
  const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`;

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/dns-json',
      },
    });

    if (!response.ok) {
      return {
        ipAddress,
        source: 'team-cymru-google-doh',
        error: `Google DNS-over-HTTPS returned status ${response.status}.`,
      };
    }

    const json = (await response.json()) as GoogleDnsResponse;
    const txt = json.Answer?.map((answer) => answer.data).find((data): data is string => Boolean(data));

    if (!txt) {
      return {
        ipAddress,
        source: 'team-cymru-google-doh',
        error: json.Comment || `No ASN TXT record was returned for ${ipAddress}.`,
      };
    }

    return parseTeamCymruRecord(ipAddress, txt);
  } catch (error) {
    return {
      ipAddress,
      source: 'team-cymru-google-doh',
      error: error instanceof Error ? error.message : 'Unknown ASN lookup error.',
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader?.('Allow', ['GET', 'POST', 'OPTIONS']);
    res.status(204).json({});
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader?.('Allow', ['GET', 'POST', 'OPTIONS']);
    res.status(405).json({
      error: 'Method not allowed. Use POST with { ipAddresses: [...] } or GET with ?ip=1.1.1.1.',
    });
    return;
  }

  const ipAddresses = extractIpAddresses(req);

  if (ipAddresses.length === 0) {
    res.status(400).json({
      error: 'No valid IPv4 addresses were provided.',
      expectedPostBody: { ipAddresses: ['8.8.8.8', '1.1.1.1'] },
      expectedGetUrl: '/api/asn?ip=8.8.8.8',
    });
    return;
  }

  const records = await Promise.all(ipAddresses.map((ipAddress) => lookupAsn(ipAddress)));

  res.status(200).json({
    records,
  });
}
