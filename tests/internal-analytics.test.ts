import test from 'node:test';
import assert from 'node:assert/strict';

import summaryHandler from '../api/internal/analytics/summary';
import reportHandler from '../api/internal/trades/report';
import { resetInternalSupabaseForTests } from '../api/lib/internal-supabase';

interface CapturedResponse {
  statusCode: number;
  body: any;
  ended: boolean;
}

function makeReq(
  method: string,
  options: {
    headers?: Record<string, string>;
    query?: Record<string, string | undefined>;
    body?: unknown;
  } = {},
) {
  const cleanedQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) cleanedQuery[k] = v;
  }
  return {
    method,
    headers: options.headers ?? {},
    query: cleanedQuery,
    body: options.body,
  } as any;
}

function makeRes(): { res: any; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: null, ended: false };
  const res: any = {
    setHeader() {
      return res;
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

test.beforeEach(() => {
  process.env.INTERNAL_ADMIN_KEY = 'test-admin-key';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetInternalSupabaseForTests();
});

test('internal analytics summary rejects missing admin key', async () => {
  const { res, captured } = makeRes();
  await summaryHandler(makeReq('GET'), res);
  assert.equal(captured.statusCode, 401);
  assert.equal(captured.body.success, false);
});

test('internal analytics summary returns 503 when internal supabase is not configured', async () => {
  const { res, captured } = makeRes();
  await summaryHandler(
    makeReq('GET', { headers: { 'x-admin-key': 'test-admin-key' } }),
    res,
  );
  assert.equal(captured.statusCode, 503);
  assert.equal(captured.body.success, false);
});

test('trade report rejects invalid event_type', async () => {
  const { res, captured } = makeRes();
  await reportHandler(
    makeReq('POST', {
      headers: { 'x-admin-key': 'test-admin-key' },
      body: { trade_id: 't-1', event_type: 'invalid' },
    }),
    res,
  );
  assert.equal(captured.statusCode, 400);
  assert.equal(captured.body.success, false);
});

test('trade report requires trade_id', async () => {
  const { res, captured } = makeRes();
  await reportHandler(
    makeReq('POST', {
      headers: { 'x-admin-key': 'test-admin-key' },
      body: { event_type: 'opened' },
    }),
    res,
  );
  assert.equal(captured.statusCode, 400);
  assert.equal(captured.body.success, false);
});
