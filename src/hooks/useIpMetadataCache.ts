import { useEffect, useMemo, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

export type CachedIpMetadata = {
  ip_address: string;
  asn?: string | null;
  asn_name?: string | null;
  asn_country?: string | null;
  rdap_org?: string | null;
  rdap_network_name?: string | null;
  rdap_country?: string | null;
  reverse_dns?: string[] | null;
  open_ports?: number[] | null;
  services?: string[] | null;
  hostnames?: string[] | null;
  flag_country_code?: string | null;
  flag_url?: string | null;
  source_status?: string | null;
};

export type CachedAsnMetadata = {
  asn: string;
  asn_name?: string | null;
  country?: string | null;
  registry?: string | null;
  route?: string | null;
  source_status?: string | null;
};

export type CachedReverseDns = {
  ip_address: string;
  hostnames?: string[] | null;
  ptr_hostnames?: string[] | null;
  fallback_hostnames?: string[] | null;
  source_status?: string | null;
  error?: string | null;
};

export type CachedExposure = {
  ip_address: string;
  source_provider?: string | null;
  service_count?: number | null;
  open_port_count?: number | null;
  top_ports?: string[] | null;
  open_ports?: number[] | null;
  service_names?: string[] | null;
  labels?: string[] | null;
  hostnames?: string[] | null;
  warning?: string | null;
  error?: string | null;
};

type IpMetadataCacheState = {
  ipMetadataByIp: Record<string, CachedIpMetadata>;
  asnMetadataByAsn: Record<string, CachedAsnMetadata>;
  reverseDnsByIp: Record<string, CachedReverseDns>;
  exposureByIp: Record<string, CachedExposure>;
  loading: boolean;
  error: string | null;
};

const EMPTY_STATE: IpMetadataCacheState = {
  ipMetadataByIp: {},
  asnMetadataByAsn: {},
  reverseDnsByIp: {},
  exposureByIp: {},
  loading: false,
  error: null,
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeAsn(value?: string | null): string | null {
  const text = value?.trim().toUpperCase();
  if (!text) return null;
  if (/^AS\d+$/.test(text)) return text;
  if (/^\d+$/.test(text)) return `AS${text}`;
  return text;
}

async function fetchRowsByIp<T extends { ip_address: string }>(table: string, ipAddresses: string[]): Promise<T[]> {
  if (!supabase || ipAddresses.length === 0) return [];

  const rows: T[] = [];
  for (const chunk of chunkValues(ipAddresses, 100)) {
    const { data, error } = await supabase.from(table).select('*').in('ip_address', chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

export function useIpMetadataCache(visibleIpAddresses: string[]): IpMetadataCacheState {
  const ipKey = useMemo(() => uniqueSorted(visibleIpAddresses).join('|'), [visibleIpAddresses]);
  const [state, setState] = useState<IpMetadataCacheState>(EMPTY_STATE);

  useEffect(() => {
    const ipAddresses = ipKey ? ipKey.split('|') : [];
    let cancelled = false;

    if (!supabase || !isSupabaseConfigured || ipAddresses.length === 0) {
      setState(EMPTY_STATE);
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    void (async () => {
      try {
        const [ipRows, reverseRows, exposureRows] = await Promise.all([
          fetchRowsByIp<CachedIpMetadata>('ip_metadata', ipAddresses),
          fetchRowsByIp<CachedReverseDns>('reverse_dns_cache', ipAddresses),
          fetchRowsByIp<CachedExposure>('exposure_cache', ipAddresses),
        ]);

        const asns = uniqueSorted(ipRows.map((row) => normalizeAsn(row.asn)).filter((asn): asn is string => Boolean(asn)));
        const asnRows: CachedAsnMetadata[] = [];
        if (supabase && asns.length > 0) {
          for (const chunk of chunkValues(asns, 100)) {
            const { data, error } = await supabase.from('asn_metadata').select('*').in('asn', chunk);
            if (error) throw error;
            asnRows.push(...((data ?? []) as CachedAsnMetadata[]));
          }
        }

        if (cancelled) return;

        setState({
          ipMetadataByIp: Object.fromEntries(ipRows.map((row) => [row.ip_address, row])),
          asnMetadataByAsn: Object.fromEntries(asnRows.map((row) => [normalizeAsn(row.asn) ?? row.asn, row])),
          reverseDnsByIp: Object.fromEntries(reverseRows.map((row) => [row.ip_address, row])),
          exposureByIp: Object.fromEntries(exposureRows.map((row) => [row.ip_address, row])),
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Unable to read IP metadata cache';
        console.warn('IP metadata cache read failed; falling back to live lookups.', message);
        setState({ ...EMPTY_STATE, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ipKey]);

  return state;
}
