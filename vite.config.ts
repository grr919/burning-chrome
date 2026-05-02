import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { isIPv4 } from 'node:net';
import { reverse as reverseDns } from 'node:dns/promises';
import tls from 'node:tls';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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

type ReverseDnsResponse = {
  ipAddress: string;
  hostnames: string[];
  ptrHostnames: string[];
  fallbackHostnames: string[];
  error?: string;
};


type AtlasHop = {
  hop: number;
  address?: string;
  medianRtt?: number;
  timeout?: boolean;
};

type AtlasPath = {
  probeId?: number;
  sourceAddress?: string;
  destinationAddress?: string;
  hops: AtlasHop[];
};

type AtlasTracerouteResponse = {
  provider: 'ripe_atlas';
  target: string;
  measurementId?: number;
  status: 'ready' | 'pending' | 'error';
  paths: AtlasPath[];
  error?: string;
  warning?: string;
  requiresConfig?: boolean;
};

type NlnogRouteView = {
  node: string;
  location?: string;
  prefix?: string;
  asPath?: string[];
  nextHop?: string;
  localPref?: number;
  med?: number;
  origin?: string;
  rawOutput?: string;
  error?: string;
};

type NlnogRouteViewResponse = {
  provider: 'nlnog';
  target: string;
  status: 'ready' | 'error';
  views: NlnogRouteView[];
  error?: string;
};

type NlnogPrefixRoute = {
  peer?: string;
  ip?: string;
  bgp_id?: string;
  aspath?: Array<[string, string?] | string>;
  origin?: string;
  source?: string;
  communities?: Array<[string, string?] | string>;
  extended_communities?: Array<[string, string?] | string>;
  large_communities?: Array<[string, string?] | string>;
  valid?: boolean;
  ovs?: string;
  avs?: string;
  exit_nexthop?: string;
  last_update?: string;
  last_update_at?: string;
  metric?: number;
};

type NlnogPrefixApiResponse = {
  query_id?: string;
  prefix?: string;
  routes?: Record<string, NlnogPrefixRoute[]>;
  warnings?: string[];
  collected?: string;
  error?: string;
};

type ExposureRecord = {
  ipAddress: string;
  sourceProvider: 'internetdb';
  serviceCount: number;
  openPortCount: number;
  topPorts: string[];
  serviceNames: string[];
  labels: string[];
  hostnames: string[];
  lastUpdatedAt?: string;
  warning?: string;
  error?: string;
};

type InternetDbRecord = {
  ip?: string;
  ports?: number[];
  hostnames?: string[];
  cpes?: string[];
  tags?: string[];
  vulns?: string[] | Record<string, unknown>;
};

let bootstrapCache: Bootstrap | null = null;
const rdapCache = new Map<string, NormalizedRdap>();
const reverseDnsCache = new Map<string, ReverseDnsResponse>();
const exposureCache = new Map<string, ExposureRecord>();
const atlasTracerouteCache = new Map<string, AtlasTracerouteResponse>();
const execFileAsync = promisify(execFile);

type NmapPortRecord = {
  port: number;
  protocol: string;
  state: string;
  service?: string;
  version?: string;
};

type NmapInspectResponse = {
  provider: 'nmap';
  ipAddress: string;
  status: 'ready' | 'error';
  hostUp: boolean;
  hostnames: string[];
  ports: NmapPortRecord[];
  osGuess?: string;
  rawCommand?: string;
  error?: string;
  warning?: string;
};

type HttpsCertificateResponse = {
  provider: 'https_certificate';
  ipAddress: string;
  status: 'ready' | 'error';
  host: string;
  port: number;
  lookupMode?: 'direct_ip' | 'hostname_sni';
  attemptedHosts?: string[];
  statusSummary?: string;
  subjectCn?: string;
  subjectAltNames: string[];
  issuerCn?: string;
  validFrom?: string;
  validTo?: string;
  serialNumber?: string;
  fingerprint256?: string;
  authorized?: boolean;
  authorizationError?: string;
  error?: string;
  warning?: string;
};

type SshLaunchResponse = {
  provider: 'ssh_launch';
  status: 'ready' | 'error';
  ipAddress: string;
  command?: string;
  statusSummary?: string;
  error?: string;
};


type LookupProxyOptions = {
  ripeAtlasApiKey?: string;
  nmapPath?: string;
};

function pickNmapPath(configuredPath?: string): string | null {
  const candidates = [
    configuredPath,
    'C:\\Program Files (x86)\\Nmap\\nmap.exe',
    'C:\\Program Files\\Nmap\\nmap.exe',
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractXmlAttribute(tag: string, attribute: string): string | undefined {
  const match = tag.match(new RegExp(`${attribute}="([^"]*)"`));
  return match?.[1] ? decodeXmlEntities(match[1]) : undefined;
}

function parseNmapXml(xml: string, ipAddress: string, rawCommand?: string): NmapInspectResponse {
  const hostStateMatch = xml.match(/<status[^>]*state="([^"]+)"/);
  const hostUp = hostStateMatch?.[1] === 'up';

  const hostnameMatches = [...xml.matchAll(/<hostname[^>]*name="([^"]+)"/g)].map((match) => decodeXmlEntities(match[1]));
  const hostnames = [...new Set(hostnameMatches)];

  const portBlocks = [...xml.matchAll(/<port\b([^>]*)>([\s\S]*?)<\/port>/g)];
  const ports: NmapPortRecord[] = portBlocks.map((match) => {
    const portTagAttrs = match[1] ?? '';
    const innerXml = match[2] ?? '';
    const port = Number.parseInt(extractXmlAttribute(portTagAttrs, 'portid') ?? '0', 10);
    const protocol = extractXmlAttribute(portTagAttrs, 'protocol') ?? 'tcp';
    const stateTag = innerXml.match(/<state\b([^>]*)\/>/)?.[1] ?? '';
    const serviceTag = innerXml.match(/<service\b([^>]*)\/>/)?.[1] ?? '';
    const service = extractXmlAttribute(serviceTag, 'name');
    const versionParts = [
      extractXmlAttribute(serviceTag, 'product'),
      extractXmlAttribute(serviceTag, 'version'),
      extractXmlAttribute(serviceTag, 'extrainfo'),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return {
      port,
      protocol,
      state: extractXmlAttribute(stateTag, 'state') ?? 'unknown',
      service,
      version: versionParts.length > 0 ? versionParts.join(' ') : undefined,
    };
  }).filter((record) => Number.isFinite(record.port));

  const osGuess = decodeXmlEntities(xml.match(/<osmatch[^>]*name="([^"]+)"/)?.[1] ?? '');

  return {
    provider: 'nmap',
    ipAddress,
    status: 'ready',
    hostUp,
    hostnames,
    ports,
    osGuess: osGuess || undefined,
    rawCommand,
  };
}


async function getBootstrap(): Promise<Bootstrap> {
  if (bootstrapCache) return bootstrapCache;

  const response = await fetch('https://data.iana.org/rdap/ipv4.json', {
    headers: { accept: 'application/json', 'user-agent': 'vite-rdap-overlay-demo' },
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

function isNoPtrResult(error: any): boolean {
  return ['ENOTFOUND', 'ENODATA', 'ENOENT', 'ESERVFAIL', 'NOTFOUND'].includes(error?.code);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function getUniqueStrings(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].slice(0, limit);
}

function normalizeInternetDbRecord(ipAddress: string, json: InternetDbRecord): ExposureRecord {
  const ports = Array.isArray(json.ports)
    ? json.ports.filter((port): port is number => typeof port === 'number')
    : [];
  const hostnames = Array.isArray(json.hostnames)
    ? json.hostnames.filter((hostname): hostname is string => typeof hostname === 'string')
    : [];
  const cpes = Array.isArray(json.cpes)
    ? json.cpes.filter((cpe): cpe is string => typeof cpe === 'string')
    : [];
  const tags = Array.isArray(json.tags)
    ? json.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  const vulnValues = Array.isArray(json.vulns)
    ? json.vulns.filter((value): value is string => typeof value === 'string')
    : json.vulns && typeof json.vulns === 'object'
      ? Object.keys(json.vulns)
      : [];

  return {
    ipAddress,
    sourceProvider: 'internetdb',
    serviceCount: ports.length,
    openPortCount: ports.length,
    topPorts: ports.slice(0, 8).map((port) => String(port)),
    serviceNames: getUniqueStrings([...cpes, ...tags, ...vulnValues], 6),
    labels: getUniqueStrings(tags, 8),
    hostnames: getUniqueStrings(hostnames, 8),
  };
}

async function fetchInternetDbRecord(ipAddress: string): Promise<ExposureRecord> {
  const response = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ipAddress)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'vite-rdap-overlay-demo',
    },
  });

  if (!response.ok) {
    return {
      ipAddress,
      sourceProvider: 'internetdb',
      serviceCount: 0,
      openPortCount: 0,
      topPorts: [],
      serviceNames: [],
      labels: [],
      hostnames: [],
      warning: `InternetDB lookup returned status ${response.status}`,
    };
  }

  return normalizeInternetDbRecord(ipAddress, (await response.json()) as InternetDbRecord);
}

async function fetchInternetDbExposureBatch(ipAddresses: string[]): Promise<ExposureRecord[]> {
  const chunks = chunkArray(ipAddresses, 8);
  const records: ExposureRecord[] = [];

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map((ipAddress) => fetchInternetDbRecord(ipAddress)));
    records.push(...chunkResults);
  }

  return records;
}

async function getInternetDbHostnames(ipAddress: string): Promise<string[]> {
  const record = await fetchInternetDbRecord(ipAddress);
  return record.hostnames;
}



function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function parseAtlasTracerouteResults(payload: any): AtlasPath[] {
  const results = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.latest)
        ? payload.latest
        : Array.isArray(payload?.objects)
          ? payload.objects
          : [];

  const parsed: AtlasPath[] = [];

  for (const result of results) {
    const hopsRaw = Array.isArray(result?.result) ? result.result : [];
    const hops: AtlasHop[] = [];

    for (const hopRaw of hopsRaw) {
      const replies = Array.isArray(hopRaw?.result) ? hopRaw.result : [];
      const addresses = replies
        .map((reply: any) => (typeof reply?.from === 'string' ? reply.from : undefined))
        .filter((value: string | undefined): value is string => typeof value === 'string');
      const rtts = replies
        .map((reply: any) => (typeof reply?.rtt === 'number' ? reply.rtt : undefined))
        .filter((value: number | undefined): value is number => typeof value === 'number');

      hops.push({
        hop: typeof hopRaw?.hop === 'number' ? hopRaw.hop : hops.length + 1,
        address: addresses[0],
        medianRtt: median(rtts),
        timeout: addresses.length === 0,
      });
    }

    parsed.push({
      probeId: typeof result?.prb_id === 'number' ? result.prb_id : undefined,
      sourceAddress: typeof result?.from === 'string' ? result.from : typeof result?.srcaddr === 'string' ? result.srcaddr : undefined,
      destinationAddress:
        typeof result?.dst_addr === 'string'
          ? result.dst_addr
          : typeof result?.addr === 'string'
            ? result.addr
            : typeof result?.destination_address === 'string'
              ? result.destination_address
              : undefined,
      hops,
    });
  }

  return parsed.filter((path) => path.hops.length > 0).slice(0, 6);
}

async function createAtlasTracerouteMeasurement(target: string, apiKey: string): Promise<number> {
  const response = await fetch('https://atlas.ripe.net/api/v2/measurements/', {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'vite-rdap-overlay-demo',
    },
    body: JSON.stringify({
      definitions: [
        {
          target,
          description: `IPv4 city routing mode to ${target}`,
          type: 'traceroute',
          af: 4,
          protocol: 'ICMP',
          paris: 1,
          first_hop: 1,
          max_hops: 24,
          resolve_on_probe: true,
          is_oneoff: true,
          is_public: true,
        },
      ],
      probes: [
        {
          requested: 4,
          type: 'region',
          value: 'northern_america',
          tags_include: ['system-ipv4-works'],
        },
      ],
    }),
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(json?.error ?? json?.detail ?? `RIPE Atlas measurement creation failed with status ${response.status}`);
  }

  const measurementId = Array.isArray(json?.measurements) && typeof json.measurements[0] === 'number'
    ? json.measurements[0]
    : typeof json?.measurement === 'number'
      ? json.measurement
      : undefined;

  if (typeof measurementId !== 'number') {
    throw new Error('RIPE Atlas did not return a measurement ID.');
  }

  return measurementId;
}

async function fetchAtlasMeasurementResults(measurementId: number): Promise<AtlasPath[]> {
  const latestResponse = await fetch(`https://atlas.ripe.net/api/v2/measurements/${measurementId}/latest/?format=json`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'vite-rdap-overlay-demo',
    },
  });

  if (latestResponse.ok) {
    const latestJson = await latestResponse.json().catch(() => null);
    const latestPaths = parseAtlasTracerouteResults(latestJson);
    if (latestPaths.length > 0) {
      return latestPaths;
    }
  }

  const resultsResponse = await fetch(`https://atlas.ripe.net/api/v2/measurements/${measurementId}/results/?format=json`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'vite-rdap-overlay-demo',
    },
  });

  if (!resultsResponse.ok) {
    throw new Error(`RIPE Atlas results lookup failed with status ${resultsResponse.status}`);
  }

  return parseAtlasTracerouteResults(await resultsResponse.json());
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runAtlasTraceroute(target: string, apiKey: string): Promise<AtlasTracerouteResponse> {
  const measurementId = await createAtlasTracerouteMeasurement(target, apiKey);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(2000);
    const paths = await fetchAtlasMeasurementResults(measurementId).catch(() => []);
    if (paths.length > 0) {
      return {
        provider: 'ripe_atlas',
        target,
        measurementId,
        status: 'ready',
        paths,
      };
    }
  }

  return {
    provider: 'ripe_atlas',
    target,
    measurementId,
    status: 'pending',
    paths: [],
    warning: 'The measurement was created, but no traceroute results were ready before the local timeout expired. Try the same target again in a moment.',
  };
}

function normalizeNlnogTarget(input: string): string {
  const value = input.trim();

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return `${value}/32`;
  }

  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':') && !value.includes('/')) {
    return `${value}/128`;
  }

  return value;
}

function flattenNlnogAsPath(aspath: NlnogPrefixRoute['aspath']): string[] {
  if (!Array.isArray(aspath)) return [];

  const parts: string[] = [];

  for (const item of aspath) {
    if (Array.isArray(item) && item.length > 0) {
      const [asn, name] = item;
      parts.push(name ? `${asn} (${name})` : String(asn));
    } else if (typeof item === 'string') {
      parts.push(item);
    }
  }

  return parts;
}

function inferNlnogLocation(peer: string | undefined): string | undefined {
  if (!peer) return undefined;

  const upper = peer.toUpperCase();
  const mappings: Array<[RegExp, string]> = [
    [/AMS/, 'Amsterdam'],
    [/LON/, 'London'],
    [/NYC|PHL|MIA|LAX|SJC|IAD/, 'United States'],
    [/FRA|FFM/, 'Frankfurt'],
    [/NRT|HKG|WAW|ZUR|VIE|DUS|NBG/, 'Europe/Asia'],
    [/SYD/, 'Sydney'],
    [/YYZ/, 'Toronto'],
  ];

  for (const [pattern, label] of mappings) {
    if (pattern.test(upper)) return label;
  }

  return undefined;
}

function buildNlnogRawOutput(route: NlnogPrefixRoute): string {
  const lines: string[] = [];

  if (route.peer) lines.push(`peer: ${route.peer}`);
  if (route.ip) lines.push(`peer IP: ${route.ip}`);
  if (route.bgp_id) lines.push(`BGP ID: ${route.bgp_id}`);
  if (route.exit_nexthop) lines.push(`next hop: ${route.exit_nexthop}`);
  if (route.origin) lines.push(`origin: ${route.origin}`);
  if (route.source) lines.push(`source: ${route.source}`);
  if (typeof route.metric === 'number') lines.push(`metric: ${route.metric}`);
  if (route.ovs) lines.push(`OVS: ${route.ovs}`);
  if (route.avs) lines.push(`AVS: ${route.avs}`);
  if (typeof route.valid === 'boolean') lines.push(`valid: ${route.valid}`);
  if (route.last_update) lines.push(`last update: ${route.last_update}`);
  if (route.last_update_at) lines.push(`last update at: ${route.last_update_at}`);

  return lines.join('\n');
}

function parseSubjectAltNames(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.replace(/^DNS:/i, '').replace(/^IP Address:/i, 'IP: '));
}

function summarizeTlsFailure(message: string, attemptedHostnameCount: number): string {
  const lower = message.toLowerCase();

  if (lower.includes('timed out')) {
    return attemptedHostnameCount > 0
      ? 'No HTTPS certificate response was received. Direct IP lookup timed out, and hostname-based SNI retries also failed.'
      : 'No HTTPS certificate response was received on port 443.';
  }

  if (lower.includes('handshake failure') || lower.includes('alert number 40')) {
    return attemptedHostnameCount > 0
      ? 'The server rejected a direct IP TLS handshake. Hostname-based SNI retries were also attempted but did not return a certificate.'
      : 'The server rejected a direct IP TLS handshake. This often means the server expects a hostname through SNI.';
  }

  if (lower.includes('certificate') && lower.includes('returned')) {
    return 'The remote host accepted the connection but did not return a usable HTTPS certificate.';
  }

  return attemptedHostnameCount > 0
    ? 'HTTPS certificate lookup failed after both direct IP and hostname-based SNI attempts.'
    : 'HTTPS certificate lookup failed.';
}

function normalizeHostnameCandidates(values: string[]): string[] {
  return [...new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter((value) =>
        value.length > 0 &&
        !isIPv4(value) &&
        /^[a-z0-9.-]+$/.test(value) &&
        value.includes('.')
      )
  )].slice(0, 8);
}

function tlsLookupWithOptionalSni(ipAddress: string, servername?: string): Promise<HttpsCertificateResponse> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (payload: HttpsCertificateResponse) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const socket = tls.connect(
      {
        host: ipAddress,
        port: 443,
        servername,
        rejectUnauthorized: false,
        timeout: 10000,
      },
      () => {
        try {
          const certificate = socket.getPeerCertificate(true) as any;

          if (!certificate || Object.keys(certificate).length === 0) {
            finish({
              provider: 'https_certificate',
              ipAddress,
              status: 'error',
              host: servername ?? ipAddress,
              port: 443,
              lookupMode: servername ? 'hostname_sni' : 'direct_ip',
              attemptedHosts: [servername ?? ipAddress],
              subjectAltNames: [],
              statusSummary: 'The remote host accepted the connection but did not return a usable HTTPS certificate.',
              error: 'No HTTPS certificate was returned by the remote host.',
            });
            socket.end();
            return;
          }

          finish({
            provider: 'https_certificate',
            ipAddress,
            status: 'ready',
            host: servername ?? ipAddress,
            port: 443,
            lookupMode: servername ? 'hostname_sni' : 'direct_ip',
            attemptedHosts: [servername ?? ipAddress],
            statusSummary: servername
              ? 'HTTPS certificate retrieved successfully after retrying with a hostname-based SNI request.'
              : 'HTTPS certificate retrieved successfully using a direct IP lookup.',
            subjectCn: typeof certificate.subject?.CN === 'string' ? certificate.subject.CN : undefined,
            subjectAltNames: parseSubjectAltNames(typeof certificate.subjectaltname === 'string' ? certificate.subjectaltname : undefined),
            issuerCn: typeof certificate.issuer?.CN === 'string' ? certificate.issuer.CN : undefined,
            validFrom: typeof certificate.valid_from === 'string' ? certificate.valid_from : undefined,
            validTo: typeof certificate.valid_to === 'string' ? certificate.valid_to : undefined,
            serialNumber: typeof certificate.serialNumber === 'string' ? certificate.serialNumber : undefined,
            fingerprint256: typeof certificate.fingerprint256 === 'string' ? certificate.fingerprint256 : undefined,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError ?? undefined,
            warning: servername
              ? 'This server appears to respond better when a hostname is provided during TLS negotiation.'
              : undefined,
          });
        } catch (error) {
          finish({
            provider: 'https_certificate',
            ipAddress,
            status: 'error',
            host: servername ?? ipAddress,
            port: 443,
            lookupMode: servername ? 'hostname_sni' : 'direct_ip',
            attemptedHosts: [servername ?? ipAddress],
            subjectAltNames: [],
            statusSummary: 'HTTPS certificate lookup failed during certificate parsing.',
            error: error instanceof Error ? error.message : 'Unknown HTTPS certificate lookup error.',
          });
        } finally {
          socket.end();
        }
      }
    );

    socket.on('error', (error) => {
      finish({
        provider: 'https_certificate',
        ipAddress,
        status: 'error',
        host: servername ?? ipAddress,
        port: 443,
        lookupMode: servername ? 'hostname_sni' : 'direct_ip',
        attemptedHosts: [servername ?? ipAddress],
        subjectAltNames: [],
        statusSummary: summarizeTlsFailure(error instanceof Error ? error.message : String(error), 0),
        error: error instanceof Error ? error.message : 'Unknown TLS connection error.',
      });
    });

    socket.on('timeout', () => {
      finish({
        provider: 'https_certificate',
        ipAddress,
        status: 'error',
        host: servername ?? ipAddress,
        port: 443,
        lookupMode: servername ? 'hostname_sni' : 'direct_ip',
        attemptedHosts: [servername ?? ipAddress],
        subjectAltNames: [],
        statusSummary: summarizeTlsFailure('timed out', 0),
        error: 'HTTPS certificate lookup timed out.',
      });
      socket.destroy();
    });
  });
}

async function lookupHttpsCertificate(ipAddress: string): Promise<HttpsCertificateResponse> {
  const hostnameCandidates = normalizeHostnameCandidates([
    ...(await reverseDns(ipAddress).catch(() => [] as string[])),
    ...(await getInternetDbHostnames(ipAddress).catch(() => [] as string[])),
  ]);

  const directResult = await tlsLookupWithOptionalSni(ipAddress);
  const attemptedHosts = [ipAddress];

  if (directResult.status === 'ready') {
    return { ...directResult, attemptedHosts };
  }

  for (const hostname of hostnameCandidates) {
    const retryResult = await tlsLookupWithOptionalSni(ipAddress, hostname);
    attemptedHosts.push(hostname);

    if (retryResult.status === 'ready') {
      const mergedSans = normalizeHostnameCandidates([
        ...retryResult.subjectAltNames.map((value) => value.replace(/^DNS:/i, '')),
        ...hostnameCandidates,
      ]);

      return {
        ...retryResult,
        attemptedHosts,
        subjectAltNames: mergedSans,
        statusSummary: 'Direct IP TLS lookup failed, but a hostname-based SNI retry returned a certificate.',
      };
    }
  }

  return {
    ...directResult,
    attemptedHosts,
    statusSummary: summarizeTlsFailure(directResult.error ?? 'HTTPS certificate lookup failed.', hostnameCandidates.length),
    warning: hostnameCandidates.length > 0
      ? `Retried with hostname-based SNI using: ${hostnameCandidates.join(', ')}`
      : directResult.warning,
  };
}


async function launchLocalSshClient(ipAddress: string): Promise<SshLaunchResponse> {
  const windowsCommand = `ssh ${ipAddress}`;
  const powershellCommand = `Start-Process powershell -ArgumentList '-NoExit','-Command','ssh ${ipAddress}'`;

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', powershellCommand],
      {
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
      }
    );

    child.on('error', (error) => {
      resolve({
        provider: 'ssh_launch',
        status: 'error',
        ipAddress,
        command: windowsCommand,
        statusSummary: 'Unable to open the local SSH client.',
        error: error instanceof Error ? error.message : 'Unknown SSH launch error.',
      });
    });

    child.on('spawn', () => {
      resolve({
        provider: 'ssh_launch',
        status: 'ready',
        ipAddress,
        command: windowsCommand,
        statusSummary: 'Opened the local SSH client in a new PowerShell window.',
      });
    });
  });
}

function lookupProxyPlugin(options: LookupProxyOptions): Plugin {
  const { ripeAtlasApiKey, nmapPath } = options;

  return {
    name: 'lookup-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/rdap', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const ip = url.searchParams.get('ip') ?? '';
          if (!isIPv4(ip)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 address.' }));
            return;
          }

          const cached = rdapCache.get(ip);
          if (cached) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(cached));
            return;
          }

          const baseUrl = await getRdapBaseUrl(ip);
          const response = await fetch(`${baseUrl}/ip/${encodeURIComponent(ip)}`, {
            redirect: 'follow',
            headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'vite-rdap-overlay-demo' },
          });

          if (!response.ok) {
            const bodyText = await response.text();
            res.statusCode = response.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `RDAP lookup failed with status ${response.status}`, details: bodyText.slice(0, 500) }));
            return;
          }

          const normalized = normalizeRdap(ip, baseUrl, await response.json());
          rdapCache.set(ip, normalized);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(normalized));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unable to complete RDAP lookup.', details: error instanceof Error ? error.message : String(error) }));
        }
      });

      server.middlewares.use('/api/reverse-dns', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const ip = url.searchParams.get('ip') ?? '';
          if (!isIPv4(ip)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 address.' }));
            return;
          }

          const cached = reverseDnsCache.get(ip);
          if (cached) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(cached));
            return;
          }

          let ptrHostnames: string[] = [];
          try {
            ptrHostnames = getUniqueStrings(await reverseDns(ip), 8);
          } catch (error) {
            if (!isNoPtrResult(error)) {
              throw error;
            }
          }

          const fallbackHostnames = ptrHostnames.length === 0 ? await getInternetDbHostnames(ip) : [];
          const normalized: ReverseDnsResponse = {
            ipAddress: ip,
            ptrHostnames,
            fallbackHostnames,
            hostnames: getUniqueStrings([...ptrHostnames, ...fallbackHostnames], 8),
          };
          reverseDnsCache.set(ip, normalized);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(normalized));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unable to complete hostname lookup.', details: error instanceof Error ? error.message : String(error) }));
        }
      });


      server.middlewares.use('/api/atlas-traceroute', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const target = url.searchParams.get('target') ?? '';
          if (!isIPv4(target)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 target.' }));
            return;
          }

          const cached = atlasTracerouteCache.get(target);
          if (cached) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(cached));
            return;
          }

          if (!ripeAtlasApiKey) {
            const notConfigured: AtlasTracerouteResponse = {
              provider: 'ripe_atlas',
              target,
              status: 'error',
              paths: [],
              requiresConfig: true,
              error: 'RIPE Atlas is not configured.',
              warning: 'Set RIPE_ATLAS_API_KEY in .env and restart the dev server.',
            };
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(notConfigured));
            return;
          }

          const result = await runAtlasTraceroute(target, ripeAtlasApiKey);
          atlasTracerouteCache.set(target, result);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              provider: 'ripe_atlas',
              status: 'error',
              paths: [],
              error: 'Unable to complete RIPE Atlas traceroute lookup.',
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });

      server.middlewares.use('/api/https-certificate', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const ip = url.searchParams.get('ip') ?? '';
          if (!isIPv4(ip)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 address.' }));
            return;
          }

          const result = await lookupHttpsCertificate(ip);
          res.statusCode = result.status === 'ready' ? 200 : 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              provider: 'https_certificate',
              status: 'error',
              host: '',
              port: 443,
              subjectAltNames: [],
              error: 'Unable to complete HTTPS certificate lookup.',
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });

      server.middlewares.use('/api/launch-ssh', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const ip = url.searchParams.get('ip') ?? '';
          if (!isIPv4(ip)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 address.' }));
            return;
          }

          const result = await launchLocalSshClient(ip);
          res.statusCode = result.status === 'ready' ? 200 : 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            provider: 'ssh_launch',
            status: 'error',
            ipAddress: '',
            statusSummary: 'Unable to open the local SSH client.',
            error: error instanceof Error ? error.message : String(error),
          } satisfies SshLaunchResponse));
        }
      });

      server.middlewares.use('/api/nmap-inspect', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          const url = new URL(req.url ?? '', 'http://localhost');
          const ip = url.searchParams.get('ip') ?? '';
          if (!isIPv4(ip)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please provide a valid IPv4 address.' }));
            return;
          }

          const resolvedNmapPath = pickNmapPath(nmapPath);
          if (!resolvedNmapPath) {
            const notConfigured: NmapInspectResponse = {
              provider: 'nmap',
              ipAddress: ip,
              status: 'error',
              hostUp: false,
              hostnames: [],
              ports: [],
              error: 'Nmap executable was not found.',
              warning: 'Set NMAP_PATH in .env or install Nmap in the default Windows folder.',
            };
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(notConfigured));
            return;
          }

          const args = ['-sV', '-oX', '-', ip];
          const { stdout, stderr } = await execFileAsync(resolvedNmapPath, args, {
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 2 * 1024 * 1024,
          });

          const parsed = parseNmapXml(stdout, ip, `${resolvedNmapPath} ${args.join(' ')}`);
          if (stderr?.trim()) {
            parsed.warning = stderr.trim();
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(parsed));
        } catch (error: any) {
          const details = error instanceof Error ? error.message : String(error);
          const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              provider: 'nmap',
              status: 'error',
              hostUp: false,
              hostnames: [],
              ports: [],
              error: 'Unable to complete Nmap inspection.',
              details,
              warning: stderr || undefined,
            })
          );
        }
      });

      server.middlewares.use('/api/nlnog-route-view', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let requestBody = '';
          await new Promise<void>((resolve, reject) => {
            req.on('data', (chunk) => {
              requestBody += chunk;
            });
            req.on('end', () => resolve());
            req.on('error', (error) => reject(error));
          });

          const parsedBody = requestBody ? JSON.parse(requestBody) : {};
          const targetRaw = typeof parsedBody?.target === 'string' ? parsedBody.target.trim() : '';
          const requestedNodes = Array.isArray(parsedBody?.nodes)
            ? parsedBody.nodes.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
            : [];

          if (!targetRaw) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing target.' }));
            return;
          }

          if (requestedNodes.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing NLNOG peer list.' }));
            return;
          }

          const target = normalizeNlnogTarget(targetRaw);
          const url = new URL('https://lg.ring.nlnog.net/api/prefix');
          url.searchParams.set('q', target);

          for (const peer of requestedNodes) {
            url.searchParams.append('peer', peer);
          }

          const upstream = await fetch(url.toString(), {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'vite-rdap-overlay-demo',
            },
          });

          const text = await upstream.text();

          let data: NlnogPrefixApiResponse | null = null;
          try {
            data = JSON.parse(text) as NlnogPrefixApiResponse;
          } catch {
            data = null;
          }

          if (!upstream.ok || !data) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                provider: 'nlnog',
                target: targetRaw,
                status: 'error',
                views: [],
                error: `NLNOG request failed with status ${upstream.status}.`,
              } satisfies NlnogRouteViewResponse)
            );
            return;
          }

          if (data.error) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                provider: 'nlnog',
                target: targetRaw,
                status: 'error',
                views: [],
                error: data.error,
              } satisfies NlnogRouteViewResponse)
            );
            return;
          }

          const views: NlnogRouteView[] = [];
          const allRoutes = Object.entries(data.routes ?? {});

          for (const [prefix, routes] of allRoutes) {
            for (const route of routes) {
              const peerName = route.peer ?? 'Unknown peer';
              views.push({
                node: peerName,
                location: inferNlnogLocation(peerName),
                prefix,
                asPath: flattenNlnogAsPath(route.aspath),
                nextHop: route.exit_nexthop,
                med: typeof route.metric === 'number' ? route.metric : undefined,
                origin: route.origin,
                rawOutput: buildNlnogRawOutput(route),
              });
            }
          }

          const payload: NlnogRouteViewResponse =
            views.length > 0
              ? {
                  provider: 'nlnog',
                  target: targetRaw,
                  status: 'ready',
                  views,
                }
              : {
                  provider: 'nlnog',
                  target: targetRaw,
                  status: 'ready',
                  views: requestedNodes.map((node) => ({
                    node,
                    error: 'No route view returned for this peer. Check that the peer name matches the public NLNOG peer list.',
                  })),
                };

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              provider: 'nlnog',
              target: '',
              status: 'error',
              views: [],
              error: 'Unable to complete NLNOG route-view lookup.',
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });

      server.middlewares.use('/api/exposure', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
          }

          let requestBody = '';
          await new Promise<void>((resolve, reject) => {
            req.on('data', (chunk) => {
              requestBody += chunk;
            });
            req.on('end', () => resolve());
            req.on('error', (error) => reject(error));
          });

          const parsedBody = requestBody ? JSON.parse(requestBody) : {};
          const ipAddresses = Array.isArray(parsedBody?.ipAddresses)
            ? parsedBody.ipAddresses.filter((value: unknown) => typeof value === 'string' && isIPv4(value))
            : [];

          if (ipAddresses.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Provide at least one valid IPv4 address in ipAddresses.' }));
            return;
          }

          const uniqueIpAddresses = [...new Set(ipAddresses)];
          const cachedRecords: ExposureRecord[] = [];
          const missingIpAddresses: string[] = [];
          for (const ipAddress of uniqueIpAddresses) {
            const cached = exposureCache.get(ipAddress);
            if (cached) {
              cachedRecords.push(cached);
            } else {
              missingIpAddresses.push(ipAddress);
            }
          }

          let fetchedRecords: ExposureRecord[] = [];

          if (missingIpAddresses.length > 0) {
            fetchedRecords = await fetchInternetDbExposureBatch(missingIpAddresses);

            for (const record of fetchedRecords) {
              exposureCache.set(record.ipAddress, record);
            }
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ records: [...cachedRecords, ...fetchedRecords] }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'Unable to complete exposure lookup.',
              details: error instanceof Error ? error.message : String(error),
            })
          );
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), lookupProxyPlugin({ ripeAtlasApiKey: env.RIPE_ATLAS_API_KEY, nmapPath: env.NMAP_PATH })],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
  };
});
