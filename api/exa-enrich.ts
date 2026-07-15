import { isIPv4 } from 'node:net';
import { createClient } from '@supabase/supabase-js';

type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

type PublicContact = {
  name: string;
  roles?: string[];
};

type PublicWebEnrichmentRequest = {
  ipAddress: string;
  organizationName?: string;
  networkName?: string;
  contacts?: PublicContact[];
  domain?: string;
  hostnames?: string[];
  reverseDnsHostnames?: string[];
  asn?: string;
  asnName?: string;
};

type ExaSearchResult = {
  title?: string;
  url?: string;
  highlights?: string[];
};

type ExaOutputContent = {
  synopsis?: string;
  primaryUrl?: string;
  matchedOrganizationName?: string;
  matchedContactName?: string;
  matchedContactRole?: string;
};

type WebEntityRow = {
  id: string;
  synopsis?: string | null;
  expires_at?: string | null;
};

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const CACHE_TTL_DAYS = 90;
const MAX_STRING_LENGTH = 160;
const MAX_HOSTNAMES = 8;
const MAX_CONTACTS = 3;
const EXA_TIMEOUT_MS = 12_000;
const NO_RESULT_MESSAGE = 'No reliable public-web information was found.';

const systemPrompt = [
  'Identify the organization, website, and any publicly documented professional contact using the supplied organization name, network name, domain, hostnames, ASN context, and contact name.',
  "Prefer the organization's official website, official staff pages, government records, institutional directories, and other authoritative public sources.",
  'Produce a factual one-to-three-sentence prose synopsis.',
  'Explain briefly what the organization does and mention the contact person and professional role only when that relationship is supported by the sources.',
  'Do not guess. If the organization is identifiable but the person is not, omit the person or state that the contact could not be confirmed.',
  'Do not include private, sensitive, or unnecessary personal information.',
  'Do not discuss the search process. Return concise prose suitable for display directly to an end user.',
].join(' ');

const outputSchema = {
  type: 'object',
  required: ['synopsis'],
  properties: {
    synopsis: {
      type: 'string',
      description: 'A factual one-to-three-sentence synopsis suitable for direct display.',
    },
    primaryUrl: {
      type: 'string',
      description: 'The most likely official organization or website URL, or an empty string.',
    },
    matchedOrganizationName: {
      type: 'string',
      description: 'The organization name supported by the sources, or an empty string.',
    },
    matchedContactName: {
      type: 'string',
      description: 'The public professional contact name supported by the sources, or an empty string.',
    },
    matchedContactRole: {
      type: 'string',
      description: "The contact's supported professional role, or an empty string.",
    },
  },
};

function getHeader(req: VercelRequest, name: string): string {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function isSameOrigin(req: VercelRequest): boolean {
  const origin = getHeader(req, 'origin');
  const host = getHeader(req, 'host');
  if (!origin || !host) {
    return true;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function cleanText(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function cleanList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => cleanText(item)).filter((item): item is string => Boolean(item)))].slice(0, maxItems);
}

function cleanContacts(value: unknown): PublicContact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_CONTACTS).map<PublicContact | null>((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name, 100);
    if (!name || name.includes('@') || /(abuse|hostmaster|postmaster|noc|security team)/i.test(name)) {
      return null;
    }
    return {
      name,
      roles: cleanList(record.roles, 4),
    };
  }).filter((item): item is PublicContact => Boolean(item));
}

function validatePayload(body: Record<string, unknown>): PublicWebEnrichmentRequest | null {
  const ipAddress = cleanText(body.ipAddress, 64);
  if (!ipAddress || !isIPv4(ipAddress)) {
    return null;
  }

  return {
    ipAddress,
    organizationName: cleanText(body.organizationName),
    networkName: cleanText(body.networkName),
    contacts: cleanContacts(body.contacts),
    domain: cleanText(body.domain, 120)?.toLowerCase(),
    hostnames: cleanList(body.hostnames, MAX_HOSTNAMES),
    reverseDnsHostnames: cleanList(body.reverseDnsHostnames, MAX_HOSTNAMES),
    asn: cleanText(body.asn, 32)?.toUpperCase(),
    asnName: cleanText(body.asnName),
  };
}

function normalizeKeyPart(value: string): string {
  return value.toLowerCase().replace(/https?:\/\//g, '').replace(/[^a-z0-9.:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildCacheKey(input: PublicWebEnrichmentRequest): string {
  if (input.organizationName && input.domain) {
    return `organization:${normalizeKeyPart(input.organizationName)}|domain:${normalizeKeyPart(input.domain)}`;
  }
  if (input.domain) {
    return `site:${normalizeKeyPart(input.domain)}`;
  }
  if (input.organizationName && input.asn) {
    return `organization:${normalizeKeyPart(input.organizationName)}|asn:${normalizeKeyPart(input.asn)}`;
  }
  if (input.organizationName) {
    return `organization:${normalizeKeyPart(input.organizationName)}|ip:${input.ipAddress}`;
  }
  const network = input.networkName ?? input.asnName ?? input.hostnames?.[0] ?? input.reverseDnsHostnames?.[0] ?? input.ipAddress;
  return `network:${normalizeKeyPart(network)}|ip:${input.ipAddress}`;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

function buildSearchQuery(input: PublicWebEnrichmentRequest): string {
  const parts: string[] = [];
  if (input.organizationName) parts.push(quote(input.organizationName));
  if (input.networkName) parts.push(quote(input.networkName));
  if (input.domain) parts.push(quote(input.domain));
  if (!input.domain && input.hostnames?.[0]) parts.push(quote(input.hostnames[0]));
  if (input.asnName) parts.push(quote(input.asnName));
  if (input.asn) parts.push(quote(input.asn));
  input.contacts?.slice(0, 2).forEach((contact) => parts.push(quote(contact.name)));
  parts.push('official organization');
  return parts.slice(0, 8).join(' ');
}

function hasMeaningfulContext(input: PublicWebEnrichmentRequest): boolean {
  return Boolean(
    input.organizationName ||
    input.networkName ||
    input.domain ||
    input.asnName ||
    input.contacts?.length ||
    input.hostnames?.length ||
    input.reverseDnsHostnames?.length
  );
}

function getRelationshipType(input: PublicWebEnrichmentRequest): string {
  if (input.organizationName || input.networkName) return 'registered_to';
  if (input.domain || input.hostnames?.length) return 'hosts_site';
  if (input.asn || input.asnName) return 'operated_by';
  if (input.contacts?.length) return 'contact_for';
  return 'associated_with';
}

function normalizeSynopsis(value: unknown): string | null {
  const text = cleanText(value, 900)?.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!text || /^[-*#]/.test(text)) {
    return null;
  }
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length === 0) {
    return text.length <= 280 ? text : null;
  }
  return sentences.slice(0, 3).join(' ');
}

function getPrimaryUrl(input: PublicWebEnrichmentRequest, output: ExaOutputContent, results: ExaSearchResult[]): string {
  const rawUrl = cleanText(output.primaryUrl, 300) || results.find((result) => result.url)?.url || '';
  if (!rawUrl) {
    return input.domain ? `https://${input.domain}` : '';
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function getConfidence(grounding: unknown): number | null {
  if (!Array.isArray(grounding)) {
    return null;
  }
  const values = grounding.map((item) => {
    const confidence = typeof item === 'object' && item ? (item as Record<string, unknown>).confidence : null;
    if (confidence === 'high') return 0.9;
    if (confidence === 'medium') return 0.6;
    if (confidence === 'low') return 0.3;
    return typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : null;
  }).filter((item): item is number => typeof item === 'number');
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

async function ensureIpLink(supabase: any, ipAddress: string, entityId: string, relationshipType: string) {
  const existing = await supabase
    .from('ip_entity_links')
    .select('id')
    .eq('ip_address', ipAddress)
    .eq('entity_id', entityId)
    .maybeSingle();

  if (!existing.data) {
    await supabase.from('ip_entity_links').insert({
      ip_address: ipAddress,
      entity_id: entityId,
      relationship_type: relationshipType,
      evidence_source: 'exa',
    });
  }
}

async function storeErrorStatus(
  supabase: any,
  cacheKey: string,
  input: PublicWebEnrichmentRequest,
  searchQuery: string
) {
  await supabase.from('web_entities').upsert({
    cache_key: cacheKey,
    entity_type: input.organizationName ? 'organization' : 'network',
    entity_name: input.organizationName ?? input.networkName ?? input.domain ?? input.asnName ?? input.ipAddress,
    domain: input.domain ?? null,
    search_query: searchQuery,
    provider: 'exa',
    status: 'error',
    error_message: 'Provider lookup failed.',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'cache_key' });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'error', message: 'Method not allowed.' });
    return;
  }

  if (!isSameOrigin(req)) {
    res.status(403).json({ status: 'error', message: 'Request not allowed.' });
    return;
  }

  const body = parseBody(req.body);
  if (!body) {
    res.status(400).json({ status: 'error', message: 'Malformed request.' });
    return;
  }

  const input = validatePayload(body);
  if (!input || !hasMeaningfulContext(input)) {
    res.status(400).json({ status: 'error', message: 'Malformed request.' });
    return;
  }

  const exaApiKey = process.env.EXA_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  if (!exaApiKey || !supabaseUrl || !supabaseSecretKey) {
    res.status(503).json({ status: 'error', ipAddress: input.ipAddress, message: NO_RESULT_MESSAGE });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false },
  });
  const cacheKey = buildCacheKey(input);
  const searchQuery = buildSearchQuery(input);
  const relationshipType = getRelationshipType(input);

  try {
    const cached = await supabase
      .from('web_entities')
      .select('id,synopsis,expires_at')
      .eq('provider', 'exa')
      .eq('cache_key', cacheKey)
      .eq('status', 'ready')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle<WebEntityRow>();

    if (cached.data?.synopsis && cached.data.id) {
      await ensureIpLink(supabase, input.ipAddress, cached.data.id, relationshipType);
      res.status(200).json({
        status: 'ready',
        ipAddress: input.ipAddress,
        synopsis: cached.data.synopsis,
        cached: true,
      });
      return;
    }
  } catch {
    // Cache failures should not expose internals or prevent a fresh lookup.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXA_TIMEOUT_MS);
  let exaJson: any;
  try {
    const exaResponse = await fetch(EXA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': exaApiKey,
      },
      body: JSON.stringify({
        query: searchQuery,
        type: 'auto',
        numResults: 5,
        systemPrompt,
        outputSchema,
        contents: {
          highlights: true,
        },
      }),
      signal: controller.signal,
    });

    if (!exaResponse.ok) {
      throw new Error('Exa request failed.');
    }
    exaJson = await exaResponse.json();
  } catch {
    try {
      await storeErrorStatus(supabase, cacheKey, input, searchQuery);
    } catch {
      // Keep provider/cache errors out of the browser response.
    }
    res.status(200).json({ status: 'not_found', ipAddress: input.ipAddress, message: NO_RESULT_MESSAGE });
    return;
  } finally {
    clearTimeout(timeout);
  }

  const outputContent = exaJson?.output?.content;
  const output = outputContent && typeof outputContent === 'object' && !Array.isArray(outputContent)
    ? outputContent as ExaOutputContent
    : null;
  const synopsis = normalizeSynopsis(output?.synopsis);
  if (!output || !synopsis) {
    res.status(200).json({ status: 'not_found', ipAddress: input.ipAddress, message: NO_RESULT_MESSAGE });
    return;
  }

  const results = Array.isArray(exaJson?.results) ? exaJson.results as ExaSearchResult[] : [];
  const sourceResults = results.slice(0, 5).map((result) => ({
    title: cleanText(result.title, 220) ?? '',
    url: cleanText(result.url, 300) ?? '',
    highlights: Array.isArray(result.highlights)
      ? result.highlights.map((highlight) => cleanText(highlight, 500)).filter(Boolean).slice(0, 3)
      : [],
  }));
  const primaryUrl = getPrimaryUrl(input, output, results);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const saved = await supabase.from('web_entities').upsert({
      cache_key: cacheKey,
      entity_type: input.organizationName || output.matchedOrganizationName ? 'organization' : 'network',
      entity_name: cleanText(output.matchedOrganizationName) ?? input.organizationName ?? input.networkName ?? input.domain ?? input.asnName ?? input.ipAddress,
      primary_url: primaryUrl || null,
      domain: input.domain ?? null,
      organization_context: input.organizationName ?? input.networkName ?? input.asnName ?? null,
      job_title: cleanText(output.matchedContactRole) ?? null,
      search_query: searchQuery,
      synopsis,
      source_results: sourceResults,
      confidence: getConfidence(exaJson?.output?.grounding),
      provider: 'exa',
      provider_request_id: cleanText(exaJson?.requestId ?? exaJson?.id, 120) ?? null,
      status: 'ready',
      error_message: null,
      searched_at: now.toISOString(),
      expires_at: expiresAt,
      updated_at: now.toISOString(),
    }, { onConflict: 'cache_key' }).select('id').single<WebEntityRow>();

    if (saved.data?.id) {
      await ensureIpLink(supabase, input.ipAddress, saved.data.id, relationshipType);
    }
  } catch {
    // Return the controlled fresh result even if the cache write is unavailable.
  }

  res.status(200).json({
    status: 'ready',
    ipAddress: input.ipAddress,
    synopsis,
    cached: false,
  });
}
