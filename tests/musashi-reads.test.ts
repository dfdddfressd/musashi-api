import test from 'node:test';
import assert from 'node:assert/strict';

import {
  searchMarkets,
  lookupMarket,
  getMarketSnapshots,
  getMarketResolutionContext,
} from '../src/lib/musashi-reads';
import { createMockSupabase, findFilter } from './helpers/mock-supabase';
import {
  ARCHIVED_MARKET_ROW,
  FED_MARKET_ROW,
  SAMPLE_SNAPSHOTS,
} from './helpers/sample-rows';

test('searchMarkets — applies platform=kalshi, ilike, default-active filters', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
  });

  const result = await searchMarkets({ query: 'Fed cuts', limit: 5 }, supabase);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, FED_MARKET_ROW.id);
  assert.equal(result[0].platform, 'kalshi');

  const lastCall = calls.at(-1)!;
  assert.deepEqual(findFilter(lastCall.filters, 'eq', 'platform'), [
    'eq',
    'platform',
    'kalshi',
  ]);
  assert.ok(findFilter(lastCall.filters, 'ilike', 'title'), 'ilike on title must run');
  assert.ok(findFilter(lastCall.filters, 'eq', 'is_active'), 'is_active default true');
  assert.ok(
    findFilter(lastCall.filters, 'is', 'source_missing_at'),
    'source_missing_at IS NULL default',
  );
});

test('searchMarkets — includeInactive removes is_active and source_missing filters', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [], error: null }),
  });

  await searchMarkets(
    { query: 'anything', limit: 10, includeInactive: true },
    supabase,
  );

  const lastCall = calls.at(-1)!;
  assert.equal(findFilter(lastCall.filters, 'eq', 'is_active'), undefined);
  assert.equal(findFilter(lastCall.filters, 'is', 'source_missing_at'), undefined);
});

test('searchMarkets — passes category and status filters when provided', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [], error: null }),
  });

  await searchMarkets(
    { query: 'btc', limit: 5, category: 'crypto', status: 'open' },
    supabase,
  );

  const lastCall = calls.at(-1)!;
  assert.deepEqual(findFilter(lastCall.filters, 'eq', 'category'), [
    'eq',
    'category',
    'crypto',
  ]);
  assert.deepEqual(findFilter(lastCall.filters, 'eq', 'status'), [
    'eq',
    'status',
    'open',
  ]);
});

test('lookupMarket — returns row from markets first', async () => {
  const { supabase } = createMockSupabase({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const result = await lookupMarket(
    { marketId: FED_MARKET_ROW.id },
    supabase,
  );

  assert.ok(result);
  assert.equal(result!.id, FED_MARKET_ROW.id);
  assert.equal(result!.settles_at, '2026-09-18T00:00:00Z');
  assert.equal(result!.platform, 'kalshi');
});

test('lookupMarket — falls back to markets_archive when markets is empty', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [ARCHIVED_MARKET_ROW], error: null }),
  });

  const result = await lookupMarket(
    { platformId: 'ARCHIVED-1' },
    supabase,
  );

  assert.ok(result);
  assert.equal(result!.id, ARCHIVED_MARKET_ROW.id);
  assert.equal(result!.resolved, true);
  assert.equal(result!.resolution, 'YES');
  assert.ok(
    calls.some((c) => c.table === 'markets'),
    'should query markets first',
  );
  assert.ok(
    calls.some((c) => c.table === 'markets_archive'),
    'should fall back to markets_archive',
  );
});

test('lookupMarket — returns null when neither table has the row', async () => {
  const { supabase } = createMockSupabase({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const result = await lookupMarket(
    { marketId: 'musashi-kalshi-DOES-NOT-EXIST' },
    supabase,
  );

  assert.equal(result, null);
});

test('getMarketSnapshots — returns identity + ordered snapshots, applies window cutoff', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
    markets_archive: () => ({ data: [], error: null }),
    market_snapshots: () => ({ data: SAMPLE_SNAPSHOTS, error: null }),
  });

  const result = await getMarketSnapshots(
    { marketId: FED_MARKET_ROW.id, window: '24h', limit: 50 },
    supabase,
  );

  assert.ok(result);
  assert.equal(result!.window, '24h');
  assert.equal(result!.market.id, FED_MARKET_ROW.id);
  assert.equal(result!.snapshots.length, 2);

  const snapshotCall = calls.find((c) => c.table === 'market_snapshots');
  assert.ok(snapshotCall);
  assert.ok(
    findFilter(snapshotCall!.filters, 'gte', 'snapshot_time'),
    'window=24h must produce a snapshot_time cutoff',
  );
});

test('getMarketSnapshots — window=all skips cutoff', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
    markets_archive: () => ({ data: [], error: null }),
    market_snapshots: () => ({ data: [], error: null }),
  });

  await getMarketSnapshots(
    { marketId: FED_MARKET_ROW.id, window: 'all', limit: 100 },
    supabase,
  );

  const snapshotCall = calls.find((c) => c.table === 'market_snapshots')!;
  assert.equal(findFilter(snapshotCall.filters, 'gte', 'snapshot_time'), undefined);
});

test('getMarketSnapshots — null when market not found', async () => {
  const { supabase } = createMockSupabase({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const result = await getMarketSnapshots(
    { marketId: 'missing', window: '7d', limit: 50 },
    supabase,
  );

  assert.equal(result, null);
});

test('getMarketResolutionContext — uses event_id when present, returns counts', async () => {
  const { supabase, calls } = createMockSupabase({
    markets: ({ count, filters }) => {
      if (count) {
        const hasEvent = filters.some(
          (f) => f[0] === 'eq' && f[1] === 'event_id',
        );
        return { data: null, count: hasEvent ? 4 : 12, error: null };
      }
      return { data: [FED_MARKET_ROW], error: null };
    },
    markets_archive: () => ({ data: [], error: null }),
  });

  const result = await getMarketResolutionContext(
    { marketId: FED_MARKET_ROW.id },
    supabase,
  );

  assert.ok(result);
  assert.equal(result!.market.id, FED_MARKET_ROW.id);
  assert.equal(result!.market_resolved, false);
  assert.equal(result!.category_resolution_count, 12);
  assert.equal(result!.similar_market_resolution_count, 4);
  assert.equal(result!.notes, null);

  const countCalls = calls.filter((c) => c.table === 'markets' && c.count);
  assert.equal(countCalls.length, 2);
});

test('getMarketResolutionContext — null similar count when event_id and series_id are absent, with notes', async () => {
  const rowWithoutGroup = {
    ...FED_MARKET_ROW,
    event_id: null,
    series_id: null,
  };
  const { supabase, calls } = createMockSupabase({
    markets: ({ count }) => {
      if (count) return { data: null, count: 0, error: null };
      return { data: [rowWithoutGroup], error: null };
    },
    markets_archive: () => ({ data: [], error: null }),
  });

  const result = await getMarketResolutionContext(
    { marketId: rowWithoutGroup.id },
    supabase,
  );

  assert.ok(result);
  assert.equal(result!.similar_market_resolution_count, null);
  assert.equal(result!.category_resolution_count, 0);
  assert.match(result!.notes ?? '', /similar market group/);

  const countCalls = calls.filter((c) => c.table === 'markets' && c.count);
  assert.equal(countCalls.length, 1, 'only category count should run');
});
