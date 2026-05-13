import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Real module — no mock.module. These tests exercise the singleton and reset contract.

let getServerSupabase: () => unknown;
let resetServerSupabaseForTests: () => void;

let savedUrl: string | undefined;
let savedKey: string | undefined;

before(async () => {
  savedUrl = process.env.SUPABASE_URL;
  savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

  ({ getServerSupabase, resetServerSupabaseForTests } = await import(
    '../src/api/supabase-server-client'
  ));
});

after(() => {
  resetServerSupabaseForTests();
  if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
  else delete process.env.SUPABASE_URL;
  if (savedKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
  else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe('getServerSupabase singleton', () => {
  it('returns the same instance on repeated calls', () => {
    resetServerSupabaseForTests();
    const a = getServerSupabase();
    const b = getServerSupabase();
    assert.strictEqual(a, b, 'expected same client instance (singleton)');
  });

  it('returns a new instance after resetServerSupabaseForTests()', () => {
    resetServerSupabaseForTests();
    const a = getServerSupabase();
    resetServerSupabaseForTests();
    const b = getServerSupabase();
    assert.notStrictEqual(a, b, 'expected a fresh client instance after reset');
  });

  it('throws with a descriptive message when SUPABASE_URL is missing', () => {
    resetServerSupabaseForTests();
    const orig = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    try {
      assert.throws(
        () => getServerSupabase(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes('SUPABASE_URL'),
            `expected message to mention SUPABASE_URL, got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      process.env.SUPABASE_URL = orig;
    }
  });
});
