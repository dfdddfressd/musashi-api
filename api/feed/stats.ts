import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { AnalyzedTweet, FeedStats, CronRunMetadata, AccountCategory } from '../../src/types/feed';
import { batchGetFromKV, getCached, setFeedCache, getFeedCache, getFeedCacheTimestamp } from '../lib/cache-helper';
import { kv } from '../lib/vercel-kv';
import { kvFeaturesEnabled, sendKvFeatureDisabled } from '../lib/kv-feature-guard';

// ─── KV Storage Keys ───────────────────────────────────────────────────────

const FEED_LATEST_KEY = 'feed:latest';
const CRON_METADATA_KEY = 'cron:last_run';
const STATS_CACHE_KEY = 'stats:cached';
const STATS_CACHE_CONTROL = 's-maxage=60, stale-while-revalidate=300';

function getTweetKey(tweetId: string): string {
  return `tweet:${tweetId}`;
}

function isInfraError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('kv') ||
    normalized.includes('redis') ||
    normalized.includes('upstash') ||
    normalized.includes('quota') ||
    normalized.includes('token') ||
    normalized.includes('credential') ||
    normalized.includes('connect') ||
    normalized.includes('fetch failed') ||
    normalized.includes('missing') && normalized.includes('rest')
  );
}

function getSanitizedStatsError(message: string): { status: number; error: string; note?: string } {
  if (isInfraError(message)) {
    return {
      status: 503,
      error: 'Feed stats temporarily unavailable. Check KV configuration and try again.',
      note: 'Ensure the local KV REST URL and credential are configured for feed stats.',
    };
  }

  return {
    status: 500,
    error: 'Internal server error',
  };
}

// ─── Main Handler ──────────────────────────────────────────────────────────

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const startTime = Date.now();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
    return;
  }

  if (!kvFeaturesEnabled()) {
    sendKvFeatureDisabled(res, 'Feed stats API');
    return;
  }

  try {
    // Use cached stats if available (60 second TTL)
    const cachedStats = await getCached<FeedStats>(
      STATS_CACHE_KEY,
      async () => {
        // Get last cron run metadata
        const cronMetadata = await kv.get<CronRunMetadata>(CRON_METADATA_KEY);

        // Get all tweet IDs from feed:latest
        const allTweetIds = await kv.get<string[]>(FEED_LATEST_KEY) || [];

        // OPTIMIZED: Use batch fetch (mget) instead of individual gets
        // This reduces N requests → 1 request (massive improvement!)
        const tweetKeys = allTweetIds.map((id: string) => getTweetKey(id));
        const allTweets = await batchGetFromKV<AnalyzedTweet>(kv, tweetKeys);

        const validTweets = allTweets.filter(t => t !== null) as AnalyzedTweet[];

        return await computeStats(validTweets, cronMetadata, startTime);
      },
      60000 // Cache for 60 seconds
    );

    // Cache in memory for fallback
    setFeedCache(STATS_CACHE_KEY, cachedStats, 5 * 60 * 1000); // 5 min TTL

    // Return cached stats
    res.setHeader('Cache-Control', STATS_CACHE_CONTROL);
    res.status(200).json(cachedStats);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Feed Stats API] Error:', errorMessage);

    const isQuotaError = errorMessage.includes('quota') || errorMessage.includes('max requests limit');

    // Fallback to in-memory cache on quota error
    if (isQuotaError) {
      const cachedStats = getFeedCache(STATS_CACHE_KEY);
      const cachedAt = getFeedCacheTimestamp(STATS_CACHE_KEY);

      if (cachedStats) {
        // Modify response to indicate it's cached
        const fallbackStats = {
          ...cachedStats,
          data: {
            ...cachedStats.data,
            metadata: {
              ...cachedStats.data.metadata,
              cached: true,
              cached_at: cachedAt ? new Date(cachedAt).toISOString() : null,
              cache_age_seconds: cachedAt ? Math.floor((Date.now() - cachedAt) / 1000) : null,
            },
          },
        };

        console.log(`[Feed Stats API] Serving cached stats (age: ${fallbackStats.data.metadata.cache_age_seconds}s)`);
        res.setHeader('Cache-Control', STATS_CACHE_CONTROL);
        res.status(200).json(fallbackStats);
        return;
      }
    }

    const sanitized = getSanitizedStatsError(errorMessage);
    res.setHeader('Cache-Control', STATS_CACHE_CONTROL);
    res.status(isQuotaError ? 503 : sanitized.status).json({
      success: false,
      error: isQuotaError
        ? 'Service temporarily unavailable due to quota limits. No cached data available.'
        : sanitized.error,
      ...(sanitized.note && {
        note: sanitized.note,
      }),
    });
  }
}

/**
 * Compute stats from valid tweets (extracted for caching)
 */
async function computeStats(
  validTweets: AnalyzedTweet[],
  cronMetadata: CronRunMetadata | null,
  startTime: number
): Promise<FeedStats> {

  // Time-based filtering
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  const sixHoursAgo = now - (6 * 60 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const last1h = validTweets.filter(t => new Date(t.collected_at).getTime() > oneHourAgo).length;
  const last6h = validTweets.filter(t => new Date(t.collected_at).getTime() > sixHoursAgo).length;
  const last24h = validTweets.filter(t => new Date(t.collected_at).getTime() > oneDayAgo).length;

  // Category breakdown
  const byCategory = validTweets.reduce((acc, tweet) => {
    acc[tweet.category] = (acc[tweet.category] || 0) + 1;
    return acc;
  }, {} as Record<AccountCategory, number>);

  // Urgency breakdown
  const byUrgency = validTweets.reduce((acc, tweet) => {
    acc[tweet.urgency] = (acc[tweet.urgency] || 0) + 1;
    return acc;
  }, {} as Record<'low' | 'medium' | 'high' | 'critical', number>);

  // Top markets (by mention count)
  const marketCounts = new Map<string, { market: any; count: number }>();

  for (const tweet of validTweets) {
    for (const match of tweet.matches) {
      const marketId = match.market.id;
      if (marketCounts.has(marketId)) {
        marketCounts.get(marketId)!.count++;
      } else {
        marketCounts.set(marketId, {
          market: match.market,
          count: 1,
        });
      }
    }
  }

  const topMarkets = Array.from(marketCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(item => ({
      market: item.market,
      mention_count: item.count,
    }));

  // Build response
  return {
    success: true,
    data: {
      timestamp: new Date().toISOString(),
      last_collection: cronMetadata?.timestamp || 'Never',
      tweets: {
        last_1h: last1h,
        last_6h: last6h,
        last_24h: last24h,
      },
      by_category: byCategory,
      by_urgency: byUrgency,
      top_markets: topMarkets,
      metadata: {
        processing_time_ms: Date.now() - startTime,
      },
    },
  };
}
