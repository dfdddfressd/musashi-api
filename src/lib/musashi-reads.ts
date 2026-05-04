/**
 * Read layer for the four Musashi V1 market endpoints.
 *
 * All functions here perform SELECT-only queries against the
 * musashi-infra Supabase project (markets, market_snapshots,
 * market_resolutions, markets_archive). Scoped to platform = 'kalshi'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getMusashiInfraSupabase } from './musashi-infra-supabase';
import type {
  InfraDatabase,
  InfraMarketCategory,
  InfraMarketStatus,
  InfraMarketsRow,
  InfraResolutionOutcome,
} from '../types/musashi-infra';

type InfraClient = SupabaseClient<InfraDatabase>;

export type V1Window = '24h' | '7d' | '30d' | 'all';

const WINDOW_MS: Record<Exclude<V1Window, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface SearchMarketsInput {
  query: string;
  limit: number;
  category?: InfraMarketCategory;
  status?: InfraMarketStatus;
  includeInactive?: boolean;
}

export interface SearchMarketResult {
  id: string;
  platform: 'kalshi';
  platform_id: string;
  title: string;
  category: InfraMarketCategory | null;
  status: InfraMarketStatus;
  yes_price: number | null;
  no_price: number | null;
  closes_at: string | null;
  resolved: boolean;
}

export interface MarketIdentityBlock {
  id: string;
  platform: 'kalshi';
  platform_id: string;
  title: string;
  category: InfraMarketCategory | null;
  status: InfraMarketStatus;
}

export interface MarketDetail extends MarketIdentityBlock {
  description: string | null;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
  closes_at: string | null;
  settles_at: string | null;
  resolved: boolean;
  resolution: InfraResolutionOutcome | null;
  resolved_at: string | null;
  source_missing_at: string | null;
  last_snapshot_at: string | null;
}

export interface SnapshotPoint {
  snapshot_time: string;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
}

export interface MarketHistoryResult {
  market: MarketIdentityBlock;
  window: V1Window;
  snapshots: SnapshotPoint[];
}

export interface ResolutionContextResult {
  market: MarketIdentityBlock;
  market_resolved: boolean;
  market_resolution: InfraResolutionOutcome | null;
  market_resolved_at: string | null;
  category_resolution_count: number | null;
  similar_market_resolution_count: number | null;
  notes: string | null;
}

export interface MarketIdentityInput {
  marketId?: string;
  platformId?: string;
}

const SEARCH_FIELDS =
  'id, platform, platform_id, title, category, status, yes_price, no_price, closes_at, resolved, last_snapshot_at, is_active, source_missing_at';

const FULL_MARKET_FIELDS =
  'id, platform, platform_id, event_id, series_id, title, description, category, url, yes_price, no_price, volume_24h, open_interest, liquidity, spread, status, created_at, closes_at, settles_at, resolved, resolution, resolved_at, source_missing_at, last_snapshot_at, is_active';

function client(override?: InfraClient): InfraClient {
  return override ?? getMusashiInfraSupabase();
}

export async function searchMarkets(
  input: SearchMarketsInput,
  override?: InfraClient,
): Promise<SearchMarketResult[]> {
  const supabase = client(override);
  const escaped = escapeIlike(input.query);

  let query = supabase
    .from('markets')
    .select(SEARCH_FIELDS)
    .eq('platform', 'kalshi')
    .ilike('title', `%${escaped}%`)
    .order('last_snapshot_at', { ascending: false, nullsFirst: false })
    .limit(input.limit);

  if (!input.includeInactive) {
    query = query.eq('is_active', true).is('source_missing_at', null);
  }
  if (input.category) {
    query = query.eq('category', input.category);
  }
  if (input.status) {
    query = query.eq('status', input.status);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`searchMarkets failed: ${error.message}`);
  }

  return (data ?? []).map(toSearchMarketResult);
}

export async function lookupMarket(
  input: MarketIdentityInput,
  override?: InfraClient,
): Promise<MarketDetail | null> {
  const row = await loadMarketRow(input, override);
  return row ? toMarketDetail(row) : null;
}

export async function getMarketSnapshots(
  input: MarketIdentityInput & { window: V1Window; limit: number },
  override?: InfraClient,
): Promise<MarketHistoryResult | null> {
  const supabase = client(override);

  const row = await loadMarketRow(
    { marketId: input.marketId, platformId: input.platformId },
    supabase,
  );
  if (!row) return null;

  let snapshotQuery = supabase
    .from('market_snapshots')
    .select(
      'snapshot_time, yes_price, no_price, volume_24h, open_interest, liquidity, spread',
    )
    .eq('market_id', row.id)
    .order('snapshot_time', { ascending: true })
    .limit(input.limit);

  if (input.window !== 'all') {
    const cutoff = new Date(Date.now() - WINDOW_MS[input.window]).toISOString();
    snapshotQuery = snapshotQuery.gte('snapshot_time', cutoff);
  }

  const { data, error } = await snapshotQuery;
  if (error) {
    throw new Error(`getMarketSnapshots failed: ${error.message}`);
  }

  return {
    market: toIdentityBlock(row),
    window: input.window,
    snapshots: (data ?? []).map(toSnapshotPoint),
  };
}

export async function getMarketResolutionContext(
  input: MarketIdentityInput,
  override?: InfraClient,
): Promise<ResolutionContextResult | null> {
  const supabase = client(override);

  const row = await loadMarketRow(input, supabase);
  if (!row) return null;

  const categoryCount = await countResolved(supabase, { category: row.category });

  let similarCount: number | null = null;
  if (row.event_id) {
    similarCount = await countResolved(supabase, { event_id: row.event_id });
  } else if (row.series_id) {
    similarCount = await countResolved(supabase, { series_id: row.series_id });
  }

  let notes: string | null = null;
  if (similarCount === null) {
    notes = 'No similar market group available; counts are category-level only.';
  } else if (similarCount === 0 && categoryCount === 0) {
    notes = 'No prior resolved markets in category or similar group.';
  }

  return {
    market: toIdentityBlock(row),
    market_resolved: row.resolved,
    market_resolution: row.resolution,
    market_resolved_at: row.resolved_at,
    category_resolution_count: categoryCount,
    similar_market_resolution_count: similarCount,
    notes,
  };
}

async function loadMarketRow(
  input: MarketIdentityInput,
  override?: InfraClient,
): Promise<InfraMarketsRow | null> {
  const supabase = client(override);

  const fromMarkets = await selectMarket(supabase, 'markets', input);
  if (fromMarkets) return fromMarkets;

  const fromArchive = await selectMarket(supabase, 'markets_archive', input);
  return fromArchive;
}

async function selectMarket(
  supabase: InfraClient,
  table: 'markets' | 'markets_archive',
  input: MarketIdentityInput,
): Promise<InfraMarketsRow | null> {
  let query = supabase.from(table).select(FULL_MARKET_FIELDS).limit(1);

  if (input.marketId) {
    query = query.eq('id', input.marketId);
  } else if (input.platformId) {
    query = query.eq('platform', 'kalshi').eq('platform_id', input.platformId);
  } else {
    return null;
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`${table} lookup failed: ${error.message}`);
  }

  const row = data && data.length > 0 ? (data[0] as InfraMarketsRow) : null;
  return row;
}

async function countResolved(
  supabase: InfraClient,
  filter: { category?: InfraMarketCategory; event_id?: string; series_id?: string },
): Promise<number> {
  let query = supabase
    .from('markets')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'kalshi')
    .eq('resolved', true);

  if (filter.category) query = query.eq('category', filter.category);
  if (filter.event_id) query = query.eq('event_id', filter.event_id);
  if (filter.series_id) query = query.eq('series_id', filter.series_id);

  const { count, error } = await query;
  if (error) {
    throw new Error(`countResolved failed: ${error.message}`);
  }
  return count ?? 0;
}

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toSearchMarketResult(row: Record<string, unknown>): SearchMarketResult {
  return {
    id: String(row.id),
    platform: 'kalshi',
    platform_id: String(row.platform_id),
    title: String(row.title),
    category: (row.category as InfraMarketCategory | null) ?? null,
    status: row.status as InfraMarketStatus,
    yes_price: nullableNumber(row.yes_price),
    no_price: nullableNumber(row.no_price),
    closes_at: nullableString(row.closes_at),
    resolved: Boolean(row.resolved),
  };
}

function toMarketDetail(row: InfraMarketsRow): MarketDetail {
  return {
    id: row.id,
    platform: 'kalshi',
    platform_id: row.platform_id,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    yes_price: nullableNumber(row.yes_price),
    no_price: nullableNumber(row.no_price),
    volume_24h: nullableNumber(row.volume_24h),
    open_interest: nullableNumber(row.open_interest),
    liquidity: nullableNumber(row.liquidity),
    spread: nullableNumber(row.spread),
    closes_at: row.closes_at,
    settles_at: row.settles_at,
    resolved: row.resolved,
    resolution: row.resolution,
    resolved_at: row.resolved_at,
    source_missing_at: row.source_missing_at,
    last_snapshot_at: row.last_snapshot_at,
  };
}

function toIdentityBlock(row: InfraMarketsRow): MarketIdentityBlock {
  return {
    id: row.id,
    platform: 'kalshi',
    platform_id: row.platform_id,
    title: row.title,
    category: row.category,
    status: row.status,
  };
}

function toSnapshotPoint(row: Record<string, unknown>): SnapshotPoint {
  return {
    snapshot_time: String(row.snapshot_time),
    yes_price: nullableNumber(row.yes_price),
    no_price: nullableNumber(row.no_price),
    volume_24h: nullableNumber(row.volume_24h),
    open_interest: nullableNumber(row.open_interest),
    liquidity: nullableNumber(row.liquidity),
    spread: nullableNumber(row.spread),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
