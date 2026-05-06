import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../../lib/internal-auth';
import { getInternalSupabase } from '../../lib/internal-supabase';

function parseDate(value: unknown, fallback: Date): string {
  if (typeof value !== 'string') return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback.toISOString();
  return parsed.toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    return;
  }

  if (!requireAdminKey(req, res)) return;

  const supabase = getInternalSupabase();
  if (!supabase) {
    res.status(503).json({ success: false, error: 'Supabase internal client not configured.' });
    return;
  }

  const now = new Date();
  const fromDefault = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = parseDate(req.query.from, fromDefault);
  const to = parseDate(req.query.to, now);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 10), 1), 100);

  const { data, error } = await supabase
    .from('analytics_events')
    .select('api_key_id, event_type')
    .gte('event_time', from)
    .lte('event_time', to)
    .not('api_key_id', 'is', null);

  if (error) {
    res.status(500).json({ success: false, error: error.message });
    return;
  }

  const counter = new Map<string, { requests: number; signals: number; errors: number }>();
  for (const row of data ?? []) {
    const key = row.api_key_id as string;
    const value = counter.get(key) ?? { requests: 0, signals: 0, errors: 0 };
    if (row.event_type === 'api_request') value.requests += 1;
    if (row.event_type === 'signal_generated') value.signals += 1;
    if (row.event_type === 'api_error') value.errors += 1;
    counter.set(key, value);
  }

  const top = [...counter.entries()]
    .map(([api_key_id, stats]) => ({ api_key_id, ...stats }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit);

  res.status(200).json({
    success: true,
    data: {
      from,
      to,
      count: top.length,
      keys: top,
      timestamp: new Date().toISOString(),
    },
  });
}
