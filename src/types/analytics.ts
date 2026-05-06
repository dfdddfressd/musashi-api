export type AnalyticsEventType =
  | 'api_request'
  | 'signal_generated'
  | 'trade_reported'
  | 'trade_closed'
  | 'api_error';

export type TradeEventType = 'opened' | 'filled' | 'closed' | 'canceled';

export type TradeStatus = 'opened' | 'filled' | 'closed' | 'canceled';

export type TradeSide = 'buy_yes' | 'buy_no';

export interface TradeReportPayload {
  api_key_id?: string;
  api_key?: string;
  trade_id: string;
  event_type: TradeEventType;
  market_id?: string;
  side?: TradeSide;
  size?: number;
  entry_price?: number;
  exit_price?: number;
  fees_paid?: number;
  event_at?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}
