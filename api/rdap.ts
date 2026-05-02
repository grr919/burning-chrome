// api/rdap.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const ip = req.query.ip;
  if (typeof ip !== 'string') {
    res.status(400).json({ error: 'Missing ip' });
    return;
  }

  // put your RDAP lookup logic here
  res.status(200).json({ ok: true, ip });
}
