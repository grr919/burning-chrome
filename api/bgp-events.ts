type BgpVisualEvent = {
  id: string;
  type: 'announcement' | 'withdrawal' | 'path_change' | 'flap';
  prefix?: string;
  asn?: string;
  timestamp: string;
  intensity: number;
};

type VercelRequest = {
  method?: string;
  query?: Record<string, unknown>;
};

type VercelResponse = {
  setHeader?: (name: string, value: string | string[]) => void;
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

function normalizeAsn(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().toUpperCase().match(/^AS?(\d+)$/);
  return match ? `AS${match[1]}` : null;
}

function getRequestedAsns(query: Record<string, unknown> | undefined): string[] {
  const raw = query?.asns;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(values.map(normalizeAsn).filter((asn): asn is string => Boolean(asn)))].slice(0, 128);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader?.('Cache-Control', 's-maxage=20, stale-while-revalidate=60');

  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const asns = getRequestedAsns(req.query);

  // TODO: Integrate a small, aggregated live BGP source here. For now, the
  // frontend renders no streaks unless this endpoint returns relevant events.
  const events: BgpVisualEvent[] = [];

  res.status(200).json({
    asns,
    events,
  });
}
