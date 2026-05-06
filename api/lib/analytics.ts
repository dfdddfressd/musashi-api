import { createHash } from 'node:crypto';
import type { VercelRequest } from '@vercel/node';
import type { AnalyticsEventType, TradeReportPayload, TradeStatus } from '../../src/types/analytics';
import { getInternalSupabase } from './internal-supabase';

export interface RequestTrackInput {
  req: VercelRequest;
  endpoint: string;
  method: string;
  statusCode: number;
  startTime: number;
  metadata?: Record<string, unknown>;
}

interface ApiKeyRow {
  id: string;
}

interface TradeRow {
  id: string;
  api_key_id: string;
  external_trade_id: string;
  market_id: string | null;
  side: 'buy_yes' | 'buy_no' | null;
  size: number | null;
  entry_price: number | null;
  exit_price: number | null;
  fees_paid: number | null;
  status: TradeStatus;
  opened_at: string | null;
  filled_at: string | null;
  closed_at: string | null;
  metadata: Record<string, unknown> | null;
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function resolveApiKeyFromRequest(req: VercelRequest): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  return null;
}

async function resolveOrCreateApiKeyId(params: {
  apiKeyId?: string;
  apiKeyRaw?: string | null;
}): Promise<string | null> {
  const supabase = getInternalSupabase();
  if (!supabase) return null;

  if (params.apiKeyId) {
    return params.apiKeyId;
  }

  if (!params.apiKeyRaw) {
    return null;
  }

  const keyHash = hashApiKey(params.apiKeyRaw);

  const { data, error } = await supabase
    .from('api_keys')
    .upsert({ key_hash: keyHash, status: 'active' }, { onConflict: 'key_hash' })
    .select('id')
    .single<ApiKeyRow>();

  if (error) {
    console.error('[Analytics] Failed to resolve api key id:', error.message);
    return null;
  }

  return data?.id ?? null;
}

async function insertAnalyticsEvent(payload: {
  eventType: AnalyticsEventType;
  apiKeyId?: string | null;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  latencyMs?: number;
  requestId?: string | null;
  marketId?: string;
  tradeId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  eventTime?: string;
}): Promise<void> {
  const supabase = getInternalSupabase();
  if (!supabase) return;

  const insertPayload = {
    event_type: payload.eventType,
    api_key_id: payload.apiKeyId ?? null,
    endpoint: payload.endpoint ?? null,
    method: payload.method ?? null,
    status_code: payload.statusCode ?? null,
    latency_ms: payload.latencyMs ?? null,
    request_id: payload.requestId ?? null,
    market_id: payload.marketId ?? null,
    trade_id: payload.tradeId ?? null,
    idempotency_key: payload.idempotencyKey ?? null,
    metadata: payload.metadata ?? null,
    event_time: payload.eventTime ?? new Date().toISOString(),
  };

  const { error } = await supabase.from('analytics_events').insert(insertPayload);
  if (error && !error.message.toLowerCase().includes('duplicate key')) {
    console.error('[Analytics] Failed to insert event:', error.message);
  }
}

export async function trackApiRequest(input: RequestTrackInput): Promise<void> {
  try {
    const apiKeyRaw = resolveApiKeyFromRequest(input.req);
    const apiKeyId = await resolveOrCreateApiKeyId({ apiKeyRaw });

    await insertAnalyticsEvent({
      eventType: input.statusCode >= 500 ? 'api_error' : 'api_request',
      apiKeyId,
      endpoint: input.endpoint,
      method: input.method,
      statusCode: input.statusCode,
      latencyMs: Date.now() - input.startTime,
      requestId: (typeof input.req.headers['x-request-id'] === 'string' ? input.req.headers['x-request-id'] : null),
      metadata: input.metadata,
    });
  } catch (error) {
    console.error('[Analytics] trackApiRequest failed:', error);
  }
}

export async function trackSignalGenerated(params: {
  req: VercelRequest;
  marketId?: string;
  matchCount: number;
  suggestedAction?: string;
}): Promise<void> {
  try {
    const apiKeyRaw = resolveApiKeyFromRequest(params.req);
    const apiKeyId = await resolveOrCreateApiKeyId({ apiKeyRaw });
    await insertAnalyticsEvent({
      eventType: 'signal_generated',
      apiKeyId,
      endpoint: '/api/analyze-text',
      method: 'POST',
      statusCode: 200,
      marketId: params.marketId,
      metadata: {
        match_count: params.matchCount,
        suggested_action: params.suggestedAction ?? null,
      },
    });
  } catch (error) {
    console.error('[Analytics] trackSignalGenerated failed:', error);
  }
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function computeGrossPnl(input: {
  side: 'buy_yes' | 'buy_no' | null;
  size: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
}): number | null {
  const { side, size, entryPrice, exitPrice } = input;
  if (!side || size == null || entryPrice == null || exitPrice == null) {
    return null;
  }

  const direction = side === 'buy_yes' ? 1 : -1;
  return (exitPrice - entryPrice) * size * direction;
}

export async function reportTradeExecution(payload: TradeReportPayload): Promise<{
  ok: boolean;
  trade_id?: string;
  api_key_id?: string;
  status?: TradeStatus;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  idempotent?: boolean;
  error?: string;
}> {
  const supabase = getInternalSupabase();
  if (!supabase) {
    return { ok: false, error: 'Supabase internal client not configured.' };
  }

  const apiKeyId = await resolveOrCreateApiKeyId({
    apiKeyId: payload.api_key_id,
    apiKeyRaw: payload.api_key,
  });

  if (!apiKeyId) {
    return { ok: false, error: 'api_key_id or api_key is required.' };
  }

  const idempotencyKey = payload.idempotency_key ?? `${apiKeyId}:${payload.trade_id}:${payload.event_type}`;

  const { data: existingEvent } = await supabase
    .from('analytics_events')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingEvent?.id) {
    return { ok: true, api_key_id: apiKeyId, trade_id: payload.trade_id, idempotent: true };
  }

  const { data: existingTrade, error: existingTradeError } = await supabase
    .from('trades')
    .select('*')
    .eq('api_key_id', apiKeyId)
    .eq('external_trade_id', payload.trade_id)
    .maybeSingle<TradeRow>();

  if (existingTradeError) {
    return { ok: false, error: existingTradeError.message };
  }

  const side = payload.side ?? existingTrade?.side ?? null;
  const size = toNullableNumber(payload.size) ?? existingTrade?.size ?? null;
  const entryPrice = toNullableNumber(payload.entry_price) ?? existingTrade?.entry_price ?? null;
  const exitPrice = toNullableNumber(payload.exit_price) ?? existingTrade?.exit_price ?? null;
  const feesPaid = toNullableNumber(payload.fees_paid) ?? existingTrade?.fees_paid ?? 0;

  const grossPnl = payload.event_type === 'closed'
    ? computeGrossPnl({ side, size, entryPrice, exitPrice })
    : existingTrade?.status === 'closed'
      ? computeGrossPnl({ side, size, entryPrice, exitPrice })
      : null;

  const netPnl = grossPnl == null ? null : grossPnl - (feesPaid ?? 0);

  const tradeUpdate = {
    api_key_id: apiKeyId,
    external_trade_id: payload.trade_id,
    market_id: payload.market_id ?? existingTrade?.market_id ?? null,
    side,
    size,
    entry_price: entryPrice,
    exit_price: exitPrice,
    fees_paid: feesPaid,
    status: payload.event_type,
    opened_at: payload.event_type === 'opened' ? (payload.event_at ?? new Date().toISOString()) : existingTrade?.opened_at ?? null,
    filled_at: payload.event_type === 'filled' ? (payload.event_at ?? new Date().toISOString()) : existingTrade?.filled_at ?? null,
    closed_at: payload.event_type === 'closed' ? (payload.event_at ?? new Date().toISOString()) : existingTrade?.closed_at ?? null,
    realized_pnl: grossPnl,
    net_pnl: netPnl,
    metadata: payload.metadata ?? existingTrade?.metadata ?? null,
  };

  const { error: upsertError } = await supabase
    .from('trades')
    .upsert(tradeUpdate, { onConflict: 'api_key_id,external_trade_id' });

  if (upsertError) {
    return { ok: false, error: upsertError.message };
  }

  await insertAnalyticsEvent({
    eventType: payload.event_type === 'closed' ? 'trade_closed' : 'trade_reported',
    apiKeyId,
    endpoint: '/api/internal/trades/report',
    method: 'POST',
    statusCode: 200,
    tradeId: payload.trade_id,
    marketId: payload.market_id,
    idempotencyKey,
    metadata: {
      event_type: payload.event_type,
      side,
      size,
      entry_price: entryPrice,
      exit_price: exitPrice,
      fees_paid: feesPaid,
      gross_pnl: grossPnl,
      net_pnl: netPnl,
    },
    eventTime: payload.event_at,
  });

  return {
    ok: true,
    trade_id: payload.trade_id,
    api_key_id: apiKeyId,
    status: payload.event_type,
    gross_pnl: grossPnl,
    net_pnl: netPnl,
    idempotent: false,
  };
}
