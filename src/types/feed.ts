// Feed system type definitions for Musashi v3

import { Market, MarketMatch } from './market';
import { SentimentResult } from '../analysis/sentiment-analyzer';
import { SuggestedAction } from '../analysis/signal-generator';

// ─── Twitter Account Types ────────────────────────────────────────────────

export type AccountCategory =
  | 'politics'
  | 'economics'
  | 'crypto'
  | 'technology'
  | 'geopolitics'
  | 'sports'
  | 'breaking_news'
  | 'finance';

export type AccountPriority = 'high' | 'medium';

export interface TwitterAccount {
  username: string;           // Twitter handle without @
  category: AccountCategory;
  priority: AccountPriority;
  description: string;        // Why this account is high-signal
}

// ─── Tweet Data Types ─────────────────────────────────────────────────────

export interface TweetMetrics {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
}

export interface RawTweet {
  id: string;                 // Twitter's native tweet ID
  text: string;
  author: string;             // @username
  created_at: string;         // ISO timestamp from Twitter
  metrics: TweetMetrics;
  url: string;                // https://twitter.com/{author}/status/{id}
}

// ─── Analyzed Tweet (stored in KV) ────────────────────────────────────────

export interface AnalyzedTweet {
  // Original tweet data
  tweet: RawTweet;

  // Analysis results (from existing pipeline)
  matches: MarketMatch[];     // Matched prediction markets
  sentiment: SentimentResult; // From analyzeSentiment()
  suggested_action?: SuggestedAction; // From generateSignal()

  // Feed metadata
  category: AccountCategory;  // From account list
  urgency: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;         // Highest match confidence (0-1)

  // Timestamps
  analyzed_at: string;        // ISO timestamp when analyzed
  collected_at: string;       // ISO timestamp when cron ran
}

// ─── Feed API Response Types ───────────────────────────────────────────────

export interface FeedResponse {
  success: boolean;
  data: {
    tweets: AnalyzedTweet[];
    count: number;
    timestamp: string;        // ISO timestamp of response
    cursor?: string;          // Next cursor for pagination (tweet ID)
    filters: {
      limit: number;
      category?: string;
      minUrgency?: string;
      since?: string;
    };
    metadata: {
      processing_time_ms: number;
      total_in_kv: number;    // Approximate total tweets in KV
      cached?: boolean;        // True if served from in-memory cache
      cached_at?: string | null;  // ISO timestamp when data was cached
      cache_age_seconds?: number | null; // Age of cached data in seconds
    };
  };
}

export interface FeedStats {
  success: boolean;
  data: {
    timestamp: string;
    last_collection: string;  // ISO timestamp of last cron run
    tweets: {
      last_1h: number;
      last_6h: number;
      last_24h: number;
    };
    by_category: Record<AccountCategory, number>;
    by_urgency: Record<'low' | 'medium' | 'high' | 'critical', number>;
    top_markets: Array<{
      market: Market;
      mention_count: number;
    }>;
    metadata: {
      processing_time_ms: number;
      cached?: boolean;        // True if served from in-memory cache
      cached_at?: string | null;  // ISO timestamp when data was cached
      cache_age_seconds?: number | null; // Age of cached data in seconds
    };
  };
}

export interface AccountsResponse {
  success: boolean;
  data: {
    accounts: TwitterAccount[];
    count: number;
    by_category: Record<AccountCategory, number>;
    by_priority: {
      high: number;
      medium: number;
    };
    metadata: {
      processing_time_ms: number;
    };
  };
}

// ─── Cron Metadata (stored in KV) ─────────────────────────────────────────

export interface ArchiveResult {
  attempted: number;
  upserted: number;
  failed: number;
  errors: string[];
}

export interface CronRunMetadata {
  timestamp: string;
  tweets_collected: number;   // Total tweets fetched from Twitter
  tweets_analyzed: number;    // Total tweets analyzed
  tweets_stored: number;      // Only tweets with market matches (confidence ≥0.3)
  errors: Array<{
    account: string;
    error: string;
  }>;
  duration_ms: number;
  archive?: ArchiveResult;
}

export interface AccountCursor {
  username: string;
  last_tweet_id: string;      // Most recent tweet ID fetched
  last_fetched_at: string;    // ISO timestamp
}

// ─── SDK Types ─────────────────────────────────────────────────────────────

export interface GetFeedOptions {
  limit?: number;             // Default: 20, max: 100
  category?: AccountCategory;
  minUrgency?: 'low' | 'medium' | 'high' | 'critical';
  since?: string;             // ISO timestamp
  cursor?: string;            // Tweet ID for pagination
}
