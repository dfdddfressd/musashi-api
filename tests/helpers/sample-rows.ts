import type { InfraMarketsRow } from '../../src/types/musashi-infra';

export const FED_MARKET_ROW: InfraMarketsRow = {
  id: 'musashi-kalshi-FEDCUT-2026SEP',
  platform: 'kalshi',
  platform_id: 'FEDCUT-2026SEP',
  event_id: 'evt-FED-2026',
  series_id: null,
  title: 'Will the Fed cut rates at or before September 2026?',
  description: 'Resolves YES if FOMC announces a cut by Sep 2026.',
  category: 'fed_policy',
  url: 'https://kalshi.com/markets/FEDCUT-2026SEP',
  yes_price: 0.67,
  no_price: 0.33,
  volume_24h: 104210.5,
  open_interest: 55000,
  liquidity: 82000,
  spread: 0.01,
  status: 'open',
  created_at: '2026-01-12T10:00:00Z',
  closes_at: '2026-09-17T18:00:00Z',
  settles_at: '2026-09-18T00:00:00Z',
  resolved: false,
  resolution: null,
  resolved_at: null,
  source_missing_at: null,
  first_seen_at: '2026-01-12T10:00:00Z',
  last_ingested_at: '2026-04-22T16:55:00Z',
  last_snapshot_at: '2026-04-22T16:55:00Z',
  is_active: true,
};

export const ARCHIVED_MARKET_ROW: InfraMarketsRow = {
  ...FED_MARKET_ROW,
  id: 'musashi-kalshi-ARCHIVED-1',
  platform_id: 'ARCHIVED-1',
  is_active: false,
  status: 'closed',
  resolved: true,
  resolution: 'YES',
  resolved_at: '2026-02-15T12:00:00Z',
};

export const SAMPLE_SNAPSHOTS = [
  {
    snapshot_time: '2026-04-22T14:00:00Z',
    yes_price: 0.66,
    no_price: 0.34,
    volume_24h: 100000,
    open_interest: 54000,
    liquidity: 80000,
    spread: 0.01,
  },
  {
    snapshot_time: '2026-04-22T15:00:00Z',
    yes_price: 0.67,
    no_price: 0.33,
    volume_24h: 104210,
    open_interest: 55000,
    liquidity: 82000,
    spread: 0.01,
  },
];
