import dns from 'node:dns/promises';

type AsnRecord = {
  ipAddress: string;
  asn?: string;
  asnName?: string;
  route?: string;
  country?: string;
  registry?: string;
  allocated?: string;
  source?: string;
  error?: string;
};

function reverseIpv4(ipAddress: string): string {
  const parts = ipAddress.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new Error(`Only IPv4 addresses are supported by this example route: ${ipAddress}`);
  }
  return parts.reverse().join('.');
}

function firstTxtRecord(records: string[][]): string | null {
  return records[0]?.join('') ?? null;
}

async function lookupAsnName(asn: string): Promise<string | undefined> {
  try {
    const numericAsn = asn.replace(/^AS/i, '');
    const txt = firstTxtRecord(await dns.resolveTxt(`AS${numericAsn}.asn.cymru.com`));
    if (!txt) return undefined;
    const parts = txt.split('|').map((part) => part.trim());
    return parts[4] || undefined;
  } catch {
    return undefined;
  }
}

async function lookupAsn(ipAddress: string): Promise<AsnRecord> {
  try {
    const queryName = `${reverseIpv4(ipAddress)}.origin.asn.cymru.com`;
    const txt = firstTxtRecord(await dns.resolveTxt(queryName));
    if (!txt) {
      return { ipAddress, error: 'No ASN TXT record returned.', source: 'Team Cymru DNS' };
    }

    const parts = txt.split('|').map((part) => part.trim());
    const numericAsn = parts[0];
    const route = parts[1];
    const country = parts[2];
    const registry = parts[3];
    const allocated = parts[4];
    const asn = numericAsn ? `AS${numericAsn.replace(/^AS/i, '')}` : undefined;
    const asnName = asn ? await lookupAsnName(asn) : undefined;

    return {
      ipAddress,
      asn,
      asnName,
      route,
      country,
      registry,
      allocated,
      source: 'Team Cymru DNS',
    };
  } catch (error) {
    return {
      ipAddress,
      source: 'Team Cymru DNS',
      error: error instanceof Error ? error.message : 'Unknown ASN lookup error',
    };
  }
}

// Express/Vite server-style handler. Wire this to POST /api/asn.
export async function handleAsnRoute(req: any, res: any) {
  const fromBody = Array.isArray(req.body?.ipAddresses) ? req.body.ipAddresses : [];
  const fromQuery = typeof req.query?.ip === 'string' ? [req.query.ip] : [];
  const ipAddresses = [...new Set([...fromBody, ...fromQuery].filter((value): value is string => typeof value === 'string'))].slice(0, 256);

  if (ipAddresses.length === 0) {
    res.status(400).json({ error: 'Provide ipAddresses in the POST body, or ip as a query parameter.' });
    return;
  }

  const records = await Promise.all(ipAddresses.map((ipAddress) => lookupAsn(ipAddress)));
  res.json({ records });
}
