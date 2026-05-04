/**
 * In-process handler tests. Replaces the singleton Supabase client with
 * a chainable mock and invokes each handler with fake req/res. Verifies
 * the full envelope (status, success, data, metadata) the MCP client
 * relies on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import searchHandler from '../api/markets/search';
import lookupHandler from '../api/markets/lookup';
import historyHandler from '../api/markets/history';
import resolutionContextHandler from '../api/markets/resolution-context';
import { resetMusashiInfraSupabaseForTests } from '../src/lib/musashi-infra-supabase';
import { createMockSupabase } from './helpers/mock-supabase';
import {
  ARCHIVED_MARKET_ROW,
  FED_MARKET_ROW,
  SAMPLE_SNAPSHOTS,
} from './helpers/sample-rows';

interface CapturedResponse {
  statusCode: number;
  body: any;
  ended: boolean;
}

function makeReq(query: Record<string, string | undefined>) {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return { method: 'GET', query: cleaned, headers: {} } as any;
}

function makeRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: null, ended: false };
  const res: any = {
    setHeader() {
      return res;
    },
    getHeader() {
      return undefined;
    },
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      captured.ended = true;
      return res;
    },
    end(payload?: unknown) {
      if (payload !== undefined) captured.body = payload;
      captured.ended = true;
      return res;
    },
  };
  return { res, captured };
}

function installMock(plans: Parameters<typeof createMockSupabase>[0]) {
  const { supabase, calls } = createMockSupabase(plans);
  resetMusashiInfraSupabaseForTests(supabase);
  return { calls };
}

test.beforeEach(() => {
  resetMusashiInfraSupabaseForTests(null);
});

test.afterEach(() => {
  resetMusashiInfraSupabaseForTests(null);
});

test('search endpoint — happy path returns markets array with metadata', async () => {
  installMock({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
  });

  const { res, captured } = makeRes();
  await searchHandler(makeReq({ query: 'Fed cuts', limit: '5' }), res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.success, true);
  assert.equal(captured.body.data.markets.length, 1);
  assert.equal(captured.body.data.markets[0].id, FED_MARKET_ROW.id);
  assert.ok(captured.body.metadata.fetched_at);
  assert.equal(typeof captured.body.metadata.processing_time_ms, 'number');
});

test('search endpoint — missing query returns 400', async () => {
  installMock({});
  const { res, captured } = makeRes();
  await searchHandler(makeReq({}), res);
  assert.equal(captured.statusCode, 400);
  assert.equal(captured.body.success, false);
});

test('search endpoint — bad category returns 400', async () => {
  installMock({});
  const { res, captured } = makeRes();
  await searchHandler(makeReq({ query: 'Fed', category: 'not-a-category' }), res);
  assert.equal(captured.statusCode, 400);
});

test('lookup endpoint — happy path returns full market detail', async () => {
  installMock({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const { res, captured } = makeRes();
  await lookupHandler(makeReq({ market_id: FED_MARKET_ROW.id }), res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.success, true);
  assert.equal(captured.body.data.id, FED_MARKET_ROW.id);
  assert.equal(captured.body.data.settles_at, '2026-09-18T00:00:00Z');
  assert.equal(captured.body.data.source_missing_at, null);
});

test('lookup endpoint — falls back to archive', async () => {
  installMock({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [ARCHIVED_MARKET_ROW], error: null }),
  });

  const { res, captured } = makeRes();
  await lookupHandler(makeReq({ platform_id: 'ARCHIVED-1' }), res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.data.resolved, true);
  assert.equal(captured.body.data.resolution, 'YES');
});

test('lookup endpoint — both ids returns 400', async () => {
  installMock({});
  const { res, captured } = makeRes();
  await lookupHandler(makeReq({ market_id: 'a', platform_id: 'b' }), res);
  assert.equal(captured.statusCode, 400);
});

test('lookup endpoint — neither id returns 400', async () => {
  installMock({});
  const { res, captured } = makeRes();
  await lookupHandler(makeReq({}), res);
  assert.equal(captured.statusCode, 400);
});

test('lookup endpoint — unknown id returns 404', async () => {
  installMock({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const { res, captured } = makeRes();
  await lookupHandler(makeReq({ market_id: 'musashi-kalshi-NOPE' }), res);
  assert.equal(captured.statusCode, 404);
  assert.equal(captured.body.success, false);
});

test('history endpoint — returns market identity + ordered snapshots', async () => {
  installMock({
    markets: () => ({ data: [FED_MARKET_ROW], error: null }),
    markets_archive: () => ({ data: [], error: null }),
    market_snapshots: () => ({ data: SAMPLE_SNAPSHOTS, error: null }),
  });

  const { res, captured } = makeRes();
  await historyHandler(
    makeReq({ market_id: FED_MARKET_ROW.id, window: '24h', limit: '50' }),
    res,
  );

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.data.window, '24h');
  assert.equal(captured.body.data.snapshots.length, 2);
  assert.ok(
    captured.body.data.snapshots[0].snapshot_time <=
      captured.body.data.snapshots[1].snapshot_time,
  );
});

test('history endpoint — invalid window returns 400', async () => {
  installMock({});
  const { res, captured } = makeRes();
  await historyHandler(
    makeReq({ market_id: 'x', window: 'forever' }),
    res,
  );
  assert.equal(captured.statusCode, 400);
});

test('history endpoint — unknown market returns 404', async () => {
  installMock({
    markets: () => ({ data: [], error: null }),
    markets_archive: () => ({ data: [], error: null }),
  });

  const { res, captured } = makeRes();
  await historyHandler(makeReq({ market_id: 'nope' }), res);
  assert.equal(captured.statusCode, 404);
});

test('resolution-context endpoint — happy path with event_id similar count', async () => {
  installMock({
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

  const { res, captured } = makeRes();
  await resolutionContextHandler(
    makeReq({ market_id: FED_MARKET_ROW.id }),
    res,
  );

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.data.category_resolution_count, 12);
  assert.equal(captured.body.data.similar_market_resolution_count, 4);
});

test('resolution-context endpoint — null similar count produces notes', async () => {
  const orphan = {
    ...FED_MARKET_ROW,
    id: 'musashi-kalshi-ORPHAN-1',
    platform_id: 'ORPHAN-1',
    event_id: null,
    series_id: null,
  };
  installMock({
    markets: ({ count }) => {
      if (count) return { data: null, count: 0, error: null };
      return { data: [orphan], error: null };
    },
    markets_archive: () => ({ data: [], error: null }),
  });

  const { res, captured } = makeRes();
  await resolutionContextHandler(
    makeReq({ market_id: orphan.id }),
    res,
  );

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.data.similar_market_resolution_count, null);
  assert.match(captured.body.data.notes, /similar market group/);
});
