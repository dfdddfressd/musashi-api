import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../../lib/internal-auth';
import { getInternalSupabase } from '../../lib/internal-supabase';

interface AnalyticsEventRow {
  event_type: string;
  api_key_id: string | null;
  event_time: string;
}

interface TradeSummaryRow {
  status: string;
  realized_pnl: number | null;
  net_pnl: number | null;
}

function parseDateInput(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString();
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
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = parseDateInput(typeof req.query.from === 'string' ? req.query.from : undefined, defaultFrom);
  const to = parseDateInput(typeof req.query.to === 'string' ? req.query.to : undefined, now);

  const [eventsRes, tradesRes] = await Promise.all([
    supabase
      .from('analytics_events')
      .select('event_type, api_key_id, event_time')
      .gte('event_time', from)
      .lte('event_time', to),
    supabase
      .from('trades')
      .select('status, realized_pnl, net_pnl, closed_at')
      .gte('updated_at', from)
      .lte('updated_at', to),
  ]);

  if (eventsRes.error) {
    res.status(500).json({ success: false, error: eventsRes.error.message });
    return;
  }
  if (tradesRes.error) {
    res.status(500).json({ success: false, error: tradesRes.error.message });
    return;
  }

  const events = (eventsRes.data ?? []) as AnalyticsEventRow[];
  const trades = (tradesRes.data ?? []) as TradeSummaryRow[];

  const uniqueKeys = new Set(events.map((event) => event.api_key_id).filter(Boolean));
  const dayActive = new Set(
    events
      .filter((event) => event.api_key_id)
      .map((event) => `${event.api_key_id}:${new Date(event.event_time).toISOString().slice(0, 10)}`),
  );

  const requestCount = events.filter((event) => event.event_type === 'api_request').length;
  const signalCount = events.filter((event) => event.event_type === 'signal_generated').length;
  const errorCount = events.filter((event) => event.event_type === 'api_error').length;

  const executedTrades = trades.filter((trade) => trade.status === 'filled' || trade.status === 'closed').length;
  const closedTrades = trades.filter((trade) => trade.status === 'closed').length;
  const grossPnl = trades.reduce((sum, trade) => sum + Number(trade.realized_pnl ?? 0), 0);
  const netPnl = trades.reduce((sum, trade) => sum + Number(trade.net_pnl ?? 0), 0);
  const winningClosed = trades.filter((trade) => trade.status === 'closed' && Number(trade.net_pnl ?? 0) > 0).length;
  const winRate = closedTrades > 0 ? winningClosed / closedTrades : null;

  res.status(200).json({
    success: true,
    data: {
      from,
      to,
      metrics: {
        dau: dayActive.size,
        unique_api_keys: uniqueKeys.size,
        request_count: requestCount,
        signal_count: signalCount,
        executed_trades: executedTrades,
        closed_trades: closedTrades,
        gross_pnl: grossPnl,
        net_pnl: netPnl,
        win_rate: winRate,
        error_count: errorCount,
      },
      timestamp: new Date().toISOString(),
    },
  });
}
