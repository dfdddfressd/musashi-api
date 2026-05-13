import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AnalyzedTweetRow {
  tweet_id: string;
  author: string;
  category: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  tweet_created_at: string;
  collected_at: string;
  analyzed_at: string;
  tweet_json: Record<string, unknown>;
  matches_json: unknown[];
  sentiment_json: Record<string, unknown>;
  suggested_action_json: Record<string, unknown> | null;
  inserted_at: string;
  updated_at: string;
}

export type AnalyzedTweetInsert = Omit<AnalyzedTweetRow, 'inserted_at' | 'updated_at'> & {
  inserted_at?: string;
  updated_at?: string;
};

export type ArchiveDatabase = {
  public: {
    Tables: {
      analyzed_tweets: {
        Row: AnalyzedTweetRow;
        Insert: AnalyzedTweetInsert;
        Update: Partial<AnalyzedTweetInsert>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

let cached: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side Supabase access',
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Resets the cached Supabase client. Must be called in `after`/`afterEach` whenever
 * a test imports this module directly (not via mock.module), otherwise subsequent
 * tests will silently reuse the stale client instance.
 */
export function resetServerSupabaseForTests(): void {
  cached = null;
}
