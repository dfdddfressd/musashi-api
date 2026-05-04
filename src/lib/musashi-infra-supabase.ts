import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { InfraDatabase } from '../types/musashi-infra';

let cached: SupabaseClient<InfraDatabase> | null = null;

export class MusashiInfraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MusashiInfraConfigError';
  }
}

export function getMusashiInfraSupabase(): SupabaseClient<InfraDatabase> {
  if (cached) {
    return cached;
  }

  const url = process.env.MUSASHI_INFRA_SUPABASE_URL;
  const key = process.env.MUSASHI_INFRA_SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new MusashiInfraConfigError(
      'Missing MUSASHI_INFRA_SUPABASE_URL or MUSASHI_INFRA_SUPABASE_SERVICE_KEY.',
    );
  }

  // Service role key gives full read access. Handlers built on top of this
  // client must restrict themselves to SELECT-only paths. If the infra
  // project adds RLS policies, swap to anon key + RLS.
  cached = createClient<InfraDatabase>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

export function resetMusashiInfraSupabaseForTests(
  client: SupabaseClient<InfraDatabase> | null,
): void {
  cached = client;
}
