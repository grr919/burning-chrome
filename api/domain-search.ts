import dns from 'node:dns/promises';
import { isIPv4 } from 'node:net';

type VercelRequest = {
  method?: string;
  query: Record<string, unknown>;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

type DomainSearchResult = {
  label: string;
  domain?: string;
  ip: string;
  source?: string;
  description?: string;
};

type SeedEntry = {
  label: string;
  domain: string;
  aliases: string[];
  ip: string;
  description?: string;
};

const SEED_RESULTS: SeedEntry[] = [
  {
    label: 'Johns Hopkins University',
    domain: 'jhu.edu',
    aliases: ['johns hopkins', 'johnshopkins.edu', 'jhu', 'johns hopkins university'],
    ip: '128.220.70.2',
    description: 'Representative university address.',
  },
  {
    label: 'Google',
    domain: 'google.com',
    aliases: ['google', 'google dns'],
    ip: '8.8.8.8',
    description: 'Representative public DNS address.',
  },
  {
    label: 'Cloudflare',
    domain: 'cloudflare.com',
    aliases: ['cloudflare', 'cloudflare dns'],
    ip: '1.1.1.1',
    description: 'Representative public DNS address.',
  },
];

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compactText(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function looksLikeDomain(value: string): boolean {
  const text = value.trim().toLowerCase();
  return (
    text.length <= 253 &&
    text.includes('.') &&
    /^[a-z0-9.-]+$/.test(text) &&
    text.split('.').every((part) => part.length > 0 && part.length <= 63)
  );
}

function seedMatches(query: string): DomainSearchResult[] {
  const normalizedQuery = normalizeText(query);
  const compactQuery = compactText(query);

  if (!normalizedQuery) {
    return [];
  }

  return SEED_RESULTS.filter((entry) => {
    const values = [entry.label, entry.domain, ...entry.aliases];
    return values.some((value) => {
      const normalizedValue = normalizeText(value);
      const compactValue = compactText(value);
      return normalizedValue.includes(normalizedQuery) || compactValue.includes(compactQuery);
    });
  }).map((entry) => ({
    label: entry.label,
    domain: entry.domain,
    ip: entry.ip,
    source: 'seed',
    description: entry.description,
  }));
}

function dedupeResults(results: DomainSearchResult[]): DomainSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.ip}|${result.domain ?? result.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!rawQuery) {
    res.status(400).json({ error: 'Please provide a search query.' });
    return;
  }

  const results: DomainSearchResult[] = [];

  if (isIPv4(rawQuery)) {
    results.push({
      label: rawQuery,
      ip: rawQuery,
      source: 'direct-ip',
      description: 'Direct IPv4 address.',
    });
  }

  results.push(...seedMatches(rawQuery));

  if (looksLikeDomain(rawQuery)) {
    const domain = rawQuery.toLowerCase();
    try {
      const addresses = await dns.resolve4(domain);
      const ip = addresses.find((address) => isIPv4(address));
      if (ip) {
        results.push({
          label: domain,
          domain,
          ip,
          source: 'dns',
          description: 'Resolved from DNS A records.',
        });
      }
    } catch {
      if (results.length === 0) {
        res.status(200).json({ results: [] });
        return;
      }
    }
  }

  res.status(200).json({ results: dedupeResults(results).slice(0, 12) });
}
