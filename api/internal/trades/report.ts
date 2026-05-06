import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdminKey } from '../../lib/internal-auth';
import { reportTradeExecution } from '../../lib/analytics';
import type { TradeReportPayload, TradeEventType } from '../../../src/types/analytics';

const EVENT_TYPES: TradeEventType[] = ['opened', 'filled', 'closed', 'canceled'];

function isValidEventType(value: unknown): value is TradeEventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as TradeEventType);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
    return;
  }

  if (!requireAdminKey(req, res)) return;

  const body = req.body as TradeReportPayload | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ success: false, error: 'Request body must be a JSON object.' });
    return;
  }

  if (!body.trade_id || typeof body.trade_id !== 'string') {
    res.status(400).json({ success: false, error: 'trade_id is required.' });
    return;
  }

  if (!isValidEventType(body.event_type)) {
    res.status(400).json({ success: false, error: 'event_type must be one of: opened, filled, closed, canceled.' });
    return;
  }

  const result = await reportTradeExecution(body);
  if (!result.ok) {
    res.status(400).json({ success: false, error: result.error ?? 'Unable to report trade.' });
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      trade_id: result.trade_id,
      api_key_id: result.api_key_id,
      status: result.status,
      idempotent: result.idempotent,
      gross_pnl: result.gross_pnl ?? null,
      net_pnl: result.net_pnl ?? null,
    },
  });
}
