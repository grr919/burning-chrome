import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dns from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import tls from 'node:tls';

type RankCategory = 'currently_verified' | 'currently_resolves' | 'cached_or_observed' | 'unverified';

type Candidate = {
  hostname: string;
  sources: Set<string>;
  sourceDetails: Set<string>;
};

type WebsiteDirectoryRow = {
  id?: string;
  ip_address: string;
  hostname: string;
  url: string | null;
  source: string;
  source_detail: string | null;
  first_seen_at?: string;
  last_seen_at?: string;
  currently_resolves_to_ip: boolean;
  http_status: number | null;
  redirect_url: string | null;
  title: string | null;
  server_header: string | null;
  confidence: number;
  rank_category: RankCategory;
  last_checked_at: string;
  created_at?: string;
  updated_at?: string;
};

type WebsiteDirectoryResponse = {
  ipAddress: string;
  cacheStatus: 'fresh' | 'refreshed' | 'disabled' | 'partial';
  ttlHours: number;
  results: WebsiteDirectoryRow[];
  warning?: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 24;
const MAX_RESULTS = 16;
const HTTP_TIMEOUT_MS = 3500;
const DNS_TIMEOUT_MS = 2500;
const TLS_TIMEOUT_MS = 5000;
const MAX_TITLE_BYTES = 32768;
const MAX_REDIRECTS = 3;

let supabaseAdmin: SupabaseClient | null | undefined;

function getSupabaseAdmin(): SupabaseClient | null {
  if (supabaseAdmin !== undefined) return supabaseAdmin;

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabaseAdmin = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;
  return supabaseAdmin;
}

function normalizeHostname(value: string): string | null {
  let normalized = value.trim().toLowerCase().replace(/^dns:/i, '').replace(/\.$/, '');
  if (normalized.startsWith('*.')) {
    normalized = normalized.slice(2);
  }

  if (
    !normalized ||
    isIPv4(normalized) ||
    normalized.length > 253 ||
    !normalized.includes('.') ||
    !/^[a-z0-9.-]+$/.test(normalized)
  ) {
    return null;
  }

  const labels = normalized.split('.');
  if (labels.some((label) => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }

  return normalized;
}

function addCandidate(candidates: Map<string, Candidate>, rawValue: unknown, source: string, detail: string): void {
  if (typeof rawValue !== 'string') return;
  const hostname = normalizeHostname(rawValue);
  if (!hostname) return;

  const existing = candidates.get(hostname);
  if (existing) {
    existing.sources.add(source);
    existing.sourceDetails.add(detail);
    return;
  }

  candidates.set(hostname, {
    hostname,
    sources: new Set([source]),
    sourceDetails: new Set([detail]),
  });
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function collectInternetDbCandidates(ipAddress: string, candidates: Map<string, Candidate>): Promise<void> {
  try {
    const response = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ipAddress)}`, {
      headers: {
        accept: 'application/json',
        'user-agent': 'burning-chrome-website-directory',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) return;
    const json = await response.json();
    for (const hostname of normalizeStringArray(json?.hostnames)) {
      addCandidate(candidates, hostname, 'internetdb', 'InternetDB hostname');
    }
  } catch (error) {
    console.warn('Website directory InternetDB lookup failed', error);
  }
}

async function collectReverseDnsCandidates(ipAddress: string, candidates: Map<string, Candidate>): Promise<void> {
  const hostnames = await withTimeout(dns.reverse(ipAddress), DNS_TIMEOUT_MS, []);
  for (const hostname of hostnames) {
    addCandidate(candidates, hostname, 'reverse_dns', 'PTR hostname');
  }
}

function parseSubjectAltNames(subjectAltName?: string): string[] {
  if (!subjectAltName) return [];
  return subjectAltName.split(',').map((value) => value.trim()).filter(Boolean);
}

function tlsLookup(ipAddress: string, servername?: string): Promise<{ subjectCn?: string; subjectAltNames: string[] }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { subjectCn?: string; subjectAltNames: string[] }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const socket = tls.connect(
      {
        host: ipAddress,
        port: 443,
        servername,
        rejectUnauthorized: false,
        timeout: TLS_TIMEOUT_MS,
      },
      () => {
        try {
          const certificate = socket.getPeerCertificate(true) as any;
          finish({
            subjectCn: typeof certificate?.subject?.CN === 'string' ? certificate.subject.CN : undefined,
            subjectAltNames: parseSubjectAltNames(typeof certificate?.subjectaltname === 'string' ? certificate.subjectaltname : undefined),
          });
        } catch (error) {
          console.warn('Website directory TLS certificate parsing failed', error);
          finish({ subjectAltNames: [] });
        } finally {
          socket.end();
        }
      }
    );

    socket.on('error', () => finish({ subjectAltNames: [] }));
    socket.on('timeout', () => {
      finish({ subjectAltNames: [] });
      socket.destroy();
    });
  });
}

async function collectTlsCandidates(ipAddress: string, candidates: Map<string, Candidate>): Promise<void> {
  const reverseHostnames = [...candidates.values()]
    .filter((candidate) => candidate.sources.has('reverse_dns'))
    .map((candidate) => candidate.hostname)
    .slice(0, 4);
  const lookupHosts = [undefined, ...reverseHostnames];

  for (const servername of lookupHosts) {
    const certificate = await tlsLookup(ipAddress, servername);
    addCandidate(candidates, certificate.subjectCn, 'tls_certificate', servername ? `TLS subject CN via SNI ${servername}` : 'TLS subject CN');
    for (const san of certificate.subjectAltNames) {
      addCandidate(candidates, san, 'tls_certificate', servername ? `TLS SAN via SNI ${servername}` : 'TLS SAN');
    }

    if (certificate.subjectCn || certificate.subjectAltNames.length > 0) {
      return;
    }
  }
}

async function collectSupabaseCandidates(ipAddress: string, candidates: Map<string, Candidate>, supabase: SupabaseClient | null): Promise<void> {
  if (!supabase) return;

  try {
    const [ipMetadata, reverseDns, exposure, directory] = await Promise.all([
      supabase.from('ip_metadata').select('reverse_dns, hostnames').eq('ip_address', ipAddress).maybeSingle(),
      supabase.from('reverse_dns_cache').select('hostnames, ptr_hostnames, fallback_hostnames').eq('ip_address', ipAddress).maybeSingle(),
      supabase.from('exposure_cache').select('hostnames').eq('ip_address', ipAddress).maybeSingle(),
      supabase.from('website_directory_cache').select('hostname').eq('ip_address', ipAddress).limit(MAX_CANDIDATES),
    ]);

    for (const hostname of normalizeStringArray(ipMetadata.data?.reverse_dns)) addCandidate(candidates, hostname, 'supabase_cache', 'ip_metadata.reverse_dns');
    for (const hostname of normalizeStringArray(ipMetadata.data?.hostnames)) addCandidate(candidates, hostname, 'supabase_cache', 'ip_metadata.hostnames');
    for (const hostname of normalizeStringArray(reverseDns.data?.hostnames)) addCandidate(candidates, hostname, 'supabase_cache', 'reverse_dns_cache.hostnames');
    for (const hostname of normalizeStringArray(reverseDns.data?.ptr_hostnames)) addCandidate(candidates, hostname, 'supabase_cache', 'reverse_dns_cache.ptr_hostnames');
    for (const hostname of normalizeStringArray(reverseDns.data?.fallback_hostnames)) addCandidate(candidates, hostname, 'supabase_cache', 'reverse_dns_cache.fallback_hostnames');
    for (const hostname of normalizeStringArray(exposure.data?.hostnames)) addCandidate(candidates, hostname, 'supabase_cache', 'exposure_cache.hostnames');
    for (const row of Array.isArray(directory.data) ? directory.data : []) addCandidate(candidates, row.hostname, 'supabase_cache', 'website_directory_cache.hostname');
  } catch (error) {
    console.warn('Website directory Supabase evidence lookup failed', error);
  }
}

async function hostnameResolvesToIp(hostname: string, ipAddress: string): Promise<boolean | null> {
  try {
    const addresses = await withTimeout(dns.resolve4(hostname), DNS_TIMEOUT_MS, []);
    return addresses.includes(ipAddress);
  } catch {
    return null;
  }
}

async function readBodyPrefix(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < MAX_TITLE_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = MAX_TITLE_BYTES - total;
    chunks.push(value.slice(0, remaining));
    total += Math.min(value.length, remaining);
    if (value.length >= remaining) break;
  }

  await reader.cancel().catch(() => undefined);
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return match[1]
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || null;
}

async function fetchWebsiteUrl(url: string, redirectCount = 0): Promise<{
  url: string;
  status: number;
  redirectUrl: string | null;
  title: string | null;
  serverHeader: string | null;
} | null> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        range: `bytes=0-${MAX_TITLE_BYTES - 1}`,
        'user-agent': 'burning-chrome-website-directory',
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const location = response.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location && redirectCount < MAX_REDIRECTS) {
      const nextUrl = new URL(location, url).toString();
      const redirected = await fetchWebsiteUrl(nextUrl, redirectCount + 1);
      return redirected ? { ...redirected, redirectUrl: redirected.url } : null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const bodyPrefix = contentType.includes('text/html') ? await readBodyPrefix(response) : '';

    return {
      url,
      status: response.status,
      redirectUrl: response.url !== url ? response.url : null,
      title: bodyPrefix ? extractTitle(bodyPrefix) : null,
      serverHeader: response.headers.get('server'),
    };
  } catch {
    return null;
  }
}

async function testWebsite(hostname: string): Promise<{
  url: string | null;
  status: number | null;
  redirectUrl: string | null;
  title: string | null;
  serverHeader: string | null;
}> {
  const httpsResult = await fetchWebsiteUrl(`https://${hostname}`);
  if (httpsResult) {
    return {
      url: httpsResult.url,
      status: httpsResult.status,
      redirectUrl: httpsResult.redirectUrl,
      title: httpsResult.title,
      serverHeader: httpsResult.serverHeader,
    };
  }

  const httpResult = await fetchWebsiteUrl(`http://${hostname}`);
  if (httpResult) {
    return {
      url: httpResult.url,
      status: httpResult.status,
      redirectUrl: httpResult.redirectUrl,
      title: httpResult.title,
      serverHeader: httpResult.serverHeader,
    };
  }

  return {
    url: null,
    status: null,
    redirectUrl: null,
    title: null,
    serverHeader: null,
  };
}

function rankCandidate(candidate: Candidate, resolvesToIp: boolean | null, httpStatus: number | null): { category: RankCategory; confidence: number } {
  if (resolvesToIp && httpStatus !== null) return { category: 'currently_verified', confidence: 100 };
  if (resolvesToIp) return { category: 'currently_resolves', confidence: 75 };
  if (candidate.sources.has('internetdb') || candidate.sources.has('tls_certificate') || candidate.sources.has('reverse_dns') || candidate.sources.has('supabase_cache')) {
    return { category: 'cached_or_observed', confidence: httpStatus !== null ? 60 : 45 };
  }
  return { category: 'unverified', confidence: 20 };
}

function sortRows(rows: WebsiteDirectoryRow[]): WebsiteDirectoryRow[] {
  const categoryOrder: Record<RankCategory, number> = {
    currently_verified: 0,
    currently_resolves: 1,
    cached_or_observed: 2,
    unverified: 3,
  };

  return [...rows].sort((a, b) => {
    const categoryDiff = categoryOrder[a.rank_category] - categoryOrder[b.rank_category];
    if (categoryDiff !== 0) return categoryDiff;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.hostname.localeCompare(b.hostname);
  });
}

async function readFreshCache(ipAddress: string, supabase: SupabaseClient | null): Promise<WebsiteDirectoryRow[] | null> {
  if (!supabase) return null;
  const freshAfter = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from('website_directory_cache')
    .select('*')
    .eq('ip_address', ipAddress)
    .gte('last_checked_at', freshAfter)
    .order('confidence', { ascending: false })
    .limit(MAX_RESULTS);

  if (error) {
    console.warn('Website directory cache read failed', error);
    return null;
  }

  return data && data.length > 0 ? sortRows(data as WebsiteDirectoryRow[]) : null;
}

async function refreshDirectory(ipAddress: string, supabase: SupabaseClient | null): Promise<WebsiteDirectoryRow[]> {
  const candidates = new Map<string, Candidate>();

  await collectSupabaseCandidates(ipAddress, candidates, supabase);
  await collectInternetDbCandidates(ipAddress, candidates);
  await collectReverseDnsCandidates(ipAddress, candidates);
  await collectTlsCandidates(ipAddress, candidates);

  const now = new Date().toISOString();
  const rows: WebsiteDirectoryRow[] = [];
  for (const candidate of [...candidates.values()].slice(0, MAX_CANDIDATES)) {
    const resolvesToIp = await hostnameResolvesToIp(candidate.hostname, ipAddress);
    const website = await testWebsite(candidate.hostname);
    const rank = rankCandidate(candidate, resolvesToIp, website.status);

    rows.push({
      ip_address: ipAddress,
      hostname: candidate.hostname,
      url: website.url,
      source: [...candidate.sources].sort().join(','),
      source_detail: [...candidate.sourceDetails].sort().join('; '),
      last_seen_at: now,
      currently_resolves_to_ip: resolvesToIp === true,
      http_status: website.status,
      redirect_url: website.redirectUrl,
      title: website.title,
      server_header: website.serverHeader,
      confidence: rank.confidence,
      rank_category: rank.category,
      last_checked_at: now,
    });
  }

  const sortedRows = sortRows(rows).slice(0, MAX_RESULTS);

  if (supabase && sortedRows.length > 0) {
    const { error } = await supabase
      .from('website_directory_cache')
      .upsert(sortedRows, { onConflict: 'ip_address,hostname' });
    if (error) {
      console.warn('Website directory cache write failed', error);
    }
  }

  return sortedRows;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const ipAddress = typeof req.query.ip === 'string' ? req.query.ip.trim() : '';
    if (!isIPv4(ipAddress)) {
      res.status(400).json({ error: 'Please provide a valid IPv4 address.' });
      return;
    }

    const supabase = getSupabaseAdmin();
    const cachedRows = await readFreshCache(ipAddress, supabase);
    if (cachedRows) {
      res.status(200).json({
        ipAddress,
        cacheStatus: 'fresh',
        ttlHours: CACHE_TTL_MS / 60 / 60 / 1000,
        results: cachedRows,
      } satisfies WebsiteDirectoryResponse);
      return;
    }

    const results = await refreshDirectory(ipAddress, supabase);
    res.status(200).json({
      ipAddress,
      cacheStatus: supabase ? 'refreshed' : 'disabled',
      ttlHours: CACHE_TTL_MS / 60 / 60 / 1000,
      results,
      warning: supabase ? undefined : 'Supabase service cache is not configured; returned live directory results only.',
    } satisfies WebsiteDirectoryResponse);
  } catch (error) {
    console.warn('Website directory lookup failed', error);
    res.status(500).json({
      error: 'Unable to complete website directory lookup.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
