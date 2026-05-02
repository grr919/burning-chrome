import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isIPv4 } from 'node:net';

type Bootstrap = {
  services: [string[], string[]][];
};

type NormalizedEntity = {
  roles: string[];
  name?: string;
  email?: string;
};

type NormalizedRdap = {
  ipAddress: string;
  networkName?: string;
  handle?: string;
  org?: string;
  country?: string;
  cidr?: string;
  startAddress?: string;
  endAddress?: string;
  entities: NormalizedEntity[];
  source?: string;
  rdapBaseUrl: string;
};

const rdapCache = new Map<string, NormalizedRdap>();
let bootstrapCache: Bootstrap | null = null;

async function getBootstrap(): Promise<Bootstrap> {
  if (bootstrapCache) return bootstrapCache;

  const response = await fetch('https://data.iana.org/rdap/ipv4.json', {
    headers: {
      accept: 'application/json',
      'user-agent': 'cyberspace-rdap-route',
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load IANA RDAP bootstrap: ${response.status}`);
  }

  bootstrapCache = (await response.json()) as Bootstrap;
  return bootstrapCache;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (parts[0] * 256 ** 3 + parts[1] * 256 ** 2 + parts[2] * 256 + parts[3]) >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
  const [base, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!base || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(base) & mask) === (ipToInt(ip) & mask);
}

async function getRdapBaseUrl(ip: string): Promise<string> {
  const bootstrap = await getBootstrap();
  for (const [cidrs, urls] of bootstrap.services) {
    if (cidrs.some((cidr) => cidrContains(cidr, ip))) {
      const preferredUrl = urls.find((url) => url.startsWith('https://')) ?? urls[0];
      return preferredUrl.replace(/\/+$/, '');
    }
  }
  throw new Error(`No RDAP service found for ${ip}`);
}

function getVcardValue(entity: any, key: string): string | undefined {
  const vcardEntries = entity?.vcardArray?.[1];
  if (!Array.isArray(vcardEntries)) return undefined;
  const match = vcardEntries.find((entry: any) => Array.isArray(entry) && entry[0] === key);
  return typeof match?.[3] === 'string' ? match[3] : undefined;
}

function pickOrganization(entities: any[]): string | undefined {
  for (const role of ['registrant', 'holder', 'administrative']) {
    const match = entities.find((entity) => Array.isArray(entity?.roles) && entity.roles.includes(role));
    const name = match ? getVcardValue(match, 'fn') : undefined;
    if (name) return name;
  }
  for (const entity of entities) {
    const name = getVcardValue(entity, 'fn');
    if (name) return name;
  }
  return undefined;
}

function normalizeRdap(ip: string, baseUrl: string, json: any): NormalizedRdap {
  const entities = Array.isArray(json?.entities) ? json.entities : [];
  const cidrEntry = Array.isArray(json?.cidr0_cidrs) ? json.cidr0_cidrs[0] : undefined;
  const sourceLink = Array.isArray(json?.links)
    ? json.links.find((link: any) => typeof link?.href === 'string' && (link.rel === 'self' || link.rel === 'related'))
    : undefined;

  return {
    ipAddress: ip,
    networkName: typeof json?.name === 'string' ? json.name : undefined,
    handle: typeof json?.handle === 'string' ? json.handle : undefined,
    org: pickOrganization(entities),
    country: typeof json?.country === 'string' ? json.country : undefined,
    cidr:
      cidrEntry && typeof cidrEntry.v4prefix === 'string' && typeof cidrEntry.length === 'number'
        ? `${cidrEntry.v4prefix}/${cidrEntry.length}`
        : undefined,
    startAddress: typeof json?.startAddress === 'string' ? json.startAddress : undefined,
    endAddress: typeof json?.endAddress === 'string' ? json.endAddress : undefined,
    entities: entities.map((entity: any) => ({
      roles: Array.isArray(entity?.roles) ? entity.roles.filter((role: unknown) => typeof role === 'string') : [],
      name: getVcardValue(entity, 'fn'),
      email: getVcardValue(entity, 'email'),
    })),
    source: typeof sourceLink?.href === 'string' ? sourceLink.href : undefined,
    rdapBaseUrl: baseUrl,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const ip = typeof req.query.ip === 'string' ? req.query.ip : '';
    if (!isIPv4(ip)) {
      res.status(400).json({ error: 'Please provide a valid IPv4 address.' });
      return;
    }

    const cached = rdapCache.get(ip);
    if (cached) {
      res.status(200).json(cached);
      return;
    }

    const baseUrl = await getRdapBaseUrl(ip);
    const response = await fetch(`${baseUrl}/ip/${encodeURIComponent(ip)}`, {
      redirect: 'follow',
      headers: {
        accept: 'application/rdap+json, application/json',
        'user-agent': 'cyberspace-rdap-route',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text();
      res.status(response.status).json({
        error: `RDAP lookup failed with status ${response.status}`,
        details: bodyText.slice(0, 500),
      });
      return;
    }

    const normalized = normalizeRdap(ip, baseUrl, await response.json());
    rdapCache.set(ip, normalized);
    res.status(200).json(normalized);
  } catch (error) {
    res.status(500).json({
      error: 'Unable to complete RDAP lookup.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
