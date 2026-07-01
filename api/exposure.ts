import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isIPv4 } from 'node:net';

type ExposureRecord = {
  ipAddress: string;
  sourceProvider: 'internetdb';
  serviceCount: number;
  openPortCount: number;
  openPorts: number[];
  topPorts: string[];
  serviceNames: string[];
  labels: string[];
  hostnames: string[];
  lastUpdatedAt?: string;
  warning?: string;
  error?: string;
};

type ExposureApiResponse = {
  records: ExposureRecord[];
};

const exposureCache = new Map<string, ExposureRecord>();

function normalizeArray(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

function mapInternetDbRecord(ipAddress: string, json: any): ExposureRecord {
  const ports = Array.isArray(json?.ports)
    ? json.ports.filter((value: unknown): value is number => typeof value === 'number')
    : [];

  const tags = normalizeArray(json?.tags);
  const cpes = normalizeArray(json?.cpes);
  const hostnames = normalizeArray(json?.hostnames);

  const serviceNames = [
    ...new Set(
      [...tags, ...cpes]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ];

  const topPorts = ports
    .slice(0, 8)
    .map((port) => `${port}/tcp`);

  return {
    ipAddress,
    sourceProvider: 'internetdb',
    serviceCount: Math.max(ports.length, serviceNames.length, hostnames.length),
    openPortCount: ports.length,
    openPorts: ports,
    topPorts,
    serviceNames,
    labels: [...tags, ...cpes].slice(0, 12),
    hostnames,
    lastUpdatedAt: typeof json?.last_update === 'string' ? json.last_update : undefined,
  };
}

async function lookupInternetDb(ipAddress: string): Promise<ExposureRecord> {
  const cached = exposureCache.get(ipAddress);
  if (cached) return cached;

  const response = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ipAddress)}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'cyberspace-exposure-route',
    },
  });

  if (response.status === 404) {
    const emptyRecord: ExposureRecord = {
      ipAddress,
      sourceProvider: 'internetdb',
      serviceCount: 0,
      openPortCount: 0,
      openPorts: [],
      topPorts: [],
      serviceNames: [],
      labels: [],
      hostnames: [],
      warning: 'No public exposure data found in Shodan InternetDB.',
    };
    exposureCache.set(ipAddress, emptyRecord);
    return emptyRecord;
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`InternetDB lookup failed with status ${response.status}: ${bodyText.slice(0, 200)}`);
  }

  const record = mapInternetDbRecord(ipAddress, await response.json());
  exposureCache.set(ipAddress, record);
  return record;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const ipAddresses = Array.isArray(req.body?.ipAddresses)
      ? req.body.ipAddresses.filter((value: unknown): value is string => typeof value === 'string' && isIPv4(value))
      : [];

    if (ipAddresses.length === 0) {
      res.status(400).json({ error: 'Please provide one or more valid IPv4 addresses in ipAddresses.' });
      return;
    }

    const uniqueIps = [...new Set(ipAddresses)].slice(0, 256);

    const records = await Promise.all(
      uniqueIps.map(async (ipAddress) => {
        try {
          return await lookupInternetDb(ipAddress);
        } catch (error) {
          return {
            ipAddress,
            sourceProvider: 'internetdb' as const,
            serviceCount: 0,
            openPortCount: 0,
            openPorts: [],
            topPorts: [],
            serviceNames: [],
            labels: [],
            hostnames: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    res.status(200).json({ records } satisfies ExposureApiResponse);
  } catch (error) {
    res.status(500).json({
      error: 'Unable to complete exposure lookup.',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
