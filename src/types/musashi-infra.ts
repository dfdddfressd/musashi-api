/**
 * Row types for the musashi-infra Supabase project.
 *
 * Source of truth: musashi-infra/supabase/migrations/*. Mirror columns
 * verbatim. Add new columns here in lockstep with new migrations.
 */

export type InfraMarketPlatform = 'kalshi' | 'polymarket';
export type InfraMarketStatus = 'open' | 'closed' | 'resolved';
export type InfraResolutionOutcome = 'YES' | 'NO';

export const INFRA_MARKET_CATEGORIES = [
  'fed_policy',
  'economics',
  'financial_markets',
  'us_politics',
  'geopolitics',
  'technology',
  'crypto',
  'sports',
  'climate',
  'entertainment',
  'other',
] as const;

export type InfraMarketCategory = (typeof INFRA_MARKET_CATEGORIES)[number];

export interface InfraMarketsRow {
  id: string;
  platform: InfraMarketPlatform;
  platform_id: string;
  event_id: string | null;
  series_id: string | null;
  title: string;
  description: string | null;
  category: InfraMarketCategory;
  url: string;
  yes_price: number;
  no_price: number;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
  status: InfraMarketStatus;
  created_at: string | null;
  closes_at: string | null;
  settles_at: string | null;
  resolved: boolean;
  resolution: InfraResolutionOutcome | null;
  resolved_at: string | null;
  source_missing_at: string | null;
  first_seen_at: string;
  last_ingested_at: string;
  last_snapshot_at: string | null;
  is_active: boolean;
}

export interface InfraMarketSnapshotsRow {
  id: number;
  market_id: string;
  snapshot_time: string;
  yes_price: number;
  no_price: number;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  spread: number | null;
  source: string;
  fetch_latency_ms: number | null;
  created_at: string;
}

export interface InfraMarketResolutionsRow {
  id: number;
  market_id: string;
  outcome: InfraResolutionOutcome;
  resolved_at: string;
  final_yes_price: number | null;
  resolution_source: string;
  detected_at: string;
}

export interface InfraDatabase {
  public: {
    Tables: {
      markets: { Row: InfraMarketsRow };
      markets_archive: { Row: InfraMarketsRow };
      market_snapshots: { Row: InfraMarketSnapshotsRow };
      market_resolutions: { Row: InfraMarketResolutionsRow };
    };
  };
}
