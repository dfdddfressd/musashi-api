import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../../lib/internal-auth';
import { getInternalSupabase } from '../../lib/internal-supabase';

interface DailyMetricRow {
  day: string;
  request_count: number;
  signal_count: number;
  executed_trades: number;
  closed_trades: number;
  gross_pnl: number;
  net_pnl: number;
}

const SUPPORTED_METRICS = new Set([
  'request_count',
  'signal_count',
  'executed_trades',
  'closed_trades',
  'gross_pnl',
  'net_pnl',
]);
type SupportedMetric =
  | 'request_count'
  | 'signal_count'
  | 'executed_trades'
  | 'closed_trades'
  | 'gross_pnl'
  | 'net_pnl';

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

  const metric = typeof req.query.metric === 'string' ? req.query.metric : 'request_count';
  const granularity = typeof req.query.granularity === 'string' ? req.query.granularity : 'day';

  if (!SUPPORTED_METRICS.has(metric)) {
    res.status(400).json({ success: false, error: `Unsupported metric: ${metric}` });
    return;
  }

  if (granularity !== 'day') {
    res.status(400).json({ success: false, error: 'Only granularity=day is supported in v1.' });
    return;
  }

  const supabase = getInternalSupabase();
  if (!supabase) {
    res.status(503).json({ success: false, error: 'Supabase internal client not configured.' });
    return;
  }

  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;

  let query = supabase
    .from('daily_metrics')
    .select('day, request_count, signal_count, executed_trades, closed_trades, gross_pnl, net_pnl')
    .order('day', { ascending: true });

  if (from) query = query.gte('day', from);
  if (to) query = query.lte('day', to);

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ success: false, error: error.message });
    return;
  }

  const metricKey = metric as SupportedMetric;
  const getMetricValue = (row: DailyMetricRow, key: SupportedMetric): number => {
    switch (key) {
      case 'request_count': return row.request_count;
      case 'signal_count': return row.signal_count;
      case 'executed_trades': return row.executed_trades;
      case 'closed_trades': return row.closed_trades;
      case 'gross_pnl': return row.gross_pnl;
      case 'net_pnl': return row.net_pnl;
    }
  };

  const points = ((data ?? []) as DailyMetricRow[]).map((row) => ({
    day: row.day,
    value: Number(getMetricValue(row, metricKey) ?? 0),
  }));

  res.status(200).json({
    success: true,
    data: {
      metric,
      granularity,
      points,
      count: points.length,
      timestamp: new Date().toISOString(),
    },
  });
}
