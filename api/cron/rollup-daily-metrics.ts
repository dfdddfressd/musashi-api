import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../lib/internal-auth';
import { getInternalSupabase } from '../lib/internal-supabase';

interface AnalyticsEventRow {
  event_type: string;
  api_key_id: string | null;
  event_time: string;
}

interface TradeRollupRow {
  status: string;
  realized_pnl: number | null;
  net_pnl: number | null;
  closed_at: string | null;
  updated_at: string;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function listDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));

  while (cursor <= end) {
    days.push(toDateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use GET or POST.' });
    return;
  }

  if (!requireAdminKey(req, res)) return;

  const supabase = getInternalSupabase();
  if (!supabase) {
    res.status(503).json({ success: false, error: 'Supabase internal client not configured.' });
    return;
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const from = new Date(typeof req.query.from === 'string' ? req.query.from : defaultFrom.toISOString());
  const to = new Date(typeof req.query.to === 'string' ? req.query.to : now.toISOString());

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    res.status(400).json({ success: false, error: 'Invalid from/to range.' });
    return;
  }

  const { data: events, error: eventsError } = await supabase
    .from('analytics_events')
    .select('event_type, api_key_id, event_time')
    .gte('event_time', from.toISOString())
    .lte('event_time', to.toISOString());

  if (eventsError) {
    res.status(500).json({ success: false, error: eventsError.message });
    return;
  }

  const { data: trades, error: tradesError } = await supabase
    .from('trades')
    .select('status, realized_pnl, net_pnl, closed_at, updated_at, api_key_id')
    .gte('updated_at', from.toISOString())
    .lte('updated_at', to.toISOString());

  if (tradesError) {
    res.status(500).json({ success: false, error: tradesError.message });
    return;
  }

  const eventRows = (events ?? []) as AnalyticsEventRow[];
  const tradeRows = (trades ?? []) as TradeRollupRow[];

  const days = listDays(from, to);
  const upserts = days.map((day) => {
    const dayEvents = eventRows.filter((event) => String(event.event_time).slice(0, 10) === day);
    const dayTrades = tradeRows.filter((trade) => {
      const closed = trade.closed_at ? String(trade.closed_at).slice(0, 10) : null;
      const updated = trade.updated_at ? String(trade.updated_at).slice(0, 10) : null;
      return closed === day || updated === day;
    });

    const uniqueApiKeys = new Set(dayEvents.map((event) => event.api_key_id).filter(Boolean));
    const dau = uniqueApiKeys.size;

    const requestCount = dayEvents.filter((event) => event.event_type === 'api_request').length;
    const signalCount = dayEvents.filter((event) => event.event_type === 'signal_generated').length;
    const executedTrades = dayTrades.filter((trade) => trade.status === 'filled' || trade.status === 'closed').length;
    const closedTrades = dayTrades.filter((trade) => trade.status === 'closed').length;

    const grossPnl = dayTrades.reduce((sum, trade) => sum + Number(trade.realized_pnl ?? 0), 0);
    const netPnl = dayTrades.reduce((sum, trade) => sum + Number(trade.net_pnl ?? 0), 0);
    const wins = dayTrades.filter((trade) => trade.status === 'closed' && Number(trade.net_pnl ?? 0) > 0).length;
    const winRate = closedTrades > 0 ? wins / closedTrades : null;

    return {
      day,
      dau,
      unique_api_keys: uniqueApiKeys.size,
      request_count: requestCount,
      signal_count: signalCount,
      executed_trades: executedTrades,
      closed_trades: closedTrades,
      gross_pnl: grossPnl,
      net_pnl: netPnl,
      win_rate: winRate,
    };
  });

  const { error: upsertError } = await supabase
    .from('daily_metrics')
    .upsert(upserts, { onConflict: 'day' });

  if (upsertError) {
    res.status(500).json({ success: false, error: upsertError.message });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      from: from.toISOString(),
      to: to.toISOString(),
      days_processed: upserts.length,
      timestamp: new Date().toISOString(),
    },
  });
}
