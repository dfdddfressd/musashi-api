/**
 * Shared market cache for Vercel API endpoints
 * Prevents duplicate market fetching across endpoints
 * Stage 0: Added per-source tracking and freshness metadata
 */

import { Market, ArbitrageOpportunity } from '../../src/types/market';
import { fetchPolymarkets } from '../../src/api/polymarket-client';
import { fetchKalshiMarkets } from '../../src/api/kalshi-client';
import { detectArbitrage } from '../../src/api/arbitrage-detector';
import { FreshnessMetadata, SourceStatus } from './types';

// In-memory cache for markets
// Default: 20 seconds (configurable via MARKET_CACHE_TTL_SECONDS env var)
let cachedMarkets: Market[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = (parseInt(process.env.MARKET_CACHE_TTL_SECONDS || '20', 10)) * 1000;
// Serve stale results briefly while refreshing in background to reduce
// cold-start and expiry stampedes.
const STALE_WHILE_REVALIDATE_MS =
  (parseInt(process.env.MARKET_CACHE_SWR_SECONDS || '90', 10)) * 1000;
// Single-flight guard for upstream refreshes.
let inFlightFetch: Promise<Market[]> | null = null;

// Stage 0: Per-source tracking for freshness metadata
let polyTimestamp = 0;
let kalshiTimestamp = 0;
let polyMarketCount = 0;
let kalshiMarketCount = 0;
let polyError: string | null = null;
let kalshiError: string | null = null;

// In-memory cache for arbitrage opportunities
// Default: 15 seconds (configurable via ARBITRAGE_CACHE_TTL_SECONDS env var)
let cachedArbitrage: ArbitrageOpportunity[] = [];
let arbCacheTimestamp = 0;
// Tracks which market snapshot arbitrage was computed from.
let arbCacheMarketsStamp = -1;
const ARB_CACHE_TTL_MS = (parseInt(process.env.ARBITRAGE_CACHE_TTL_SECONDS || '15', 10)) * 1000;

const POLYMARKET_TARGET_COUNT = parsePositiveInt(process.env.MUSASHI_POLYMARKET_TARGET_COUNT, 300);
const POLYMARKET_MAX_PAGES = parsePositiveInt(process.env.MUSASHI_POLYMARKET_MAX_PAGES, 6);
const KALSHI_TARGET_COUNT = parsePositiveInt(process.env.MUSASHI_KALSHI_TARGET_COUNT, 250);
const KALSHI_MAX_PAGES = parsePositiveInt(process.env.MUSASHI_KALSHI_MAX_PAGES, 6);

// Per-source timeout (increased from 5s to reduce transient 503s)
const SOURCE_TIMEOUT_MS = parsePositiveInt(process.env.MUSASHI_SOURCE_TIMEOUT_MS, 15000);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Stage 0 Session 2: Wrap a promise with a timeout
 * If the promise doesn't resolve within timeoutMs, reject with timeout error
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param sourceName - Name of the source (for error message)
 * @returns Promise that rejects if timeout is exceeded
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  sourceName: string
): Promise<T> {
  // FIX 3: capture the timer handle so it can be cleared when promise resolves.
  // Original code never called clearTimeout — under load, unreleased timers
  // accumulated in the event loop, degrading inference latency.
  let handle: ReturnType<typeof setTimeout>;
  const timer = new Promise<T>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${sourceName} request timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

/**
 * Fetch and cache markets from both platforms
 * Shared across all API endpoints to avoid duplicate fetches
 * Stage 0: Tracks per-source timestamps and errors for freshness metadata
 */
export async function getMarkets(): Promise<Market[]> {
  const now = Date.now();
  const ageMs = now - cacheTimestamp;

  // Return cached if fresh
  if (cachedMarkets.length > 0 && ageMs < CACHE_TTL_MS) {
    console.log(`[Market Cache] Using cached ${cachedMarkets.length} markets (TTL: ${CACHE_TTL_MS}ms, age: ${ageMs}ms)`);
    return cachedMarkets;
  }

  // Serve stale while a background refresh is kicked off.
  if (cachedMarkets.length > 0 && ageMs < CACHE_TTL_MS + STALE_WHILE_REVALIDATE_MS) {
    if (!inFlightFetch) {
      console.log(`[Market Cache] SWR stale hit (age: ${ageMs}ms), refreshing in background`);
      void refreshMarkets();
    }
    return cachedMarkets;
  }

  // If an upstream refresh is already in progress, share it.
  if (inFlightFetch) {
    return inFlightFetch;
  }

  // Hard miss: refresh now.
  return refreshMarkets();
}

function refreshMarkets(): Promise<Market[]> {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async () => {
    const now = Date.now();
    try {
      const [polyResult, kalshiResult] = await Promise.allSettled([
        withTimeout(
          fetchPolymarkets(POLYMARKET_TARGET_COUNT, POLYMARKET_MAX_PAGES),
          SOURCE_TIMEOUT_MS,
          'Polymarket'
        ),
        withTimeout(
          fetchKalshiMarkets(KALSHI_TARGET_COUNT, KALSHI_MAX_PAGES),
          SOURCE_TIMEOUT_MS,
          'Kalshi'
        ),
      ]);

      // Stage 0: Track Polymarket fetch
      if (polyResult.status === 'fulfilled') {
        polyTimestamp = now;
        polyMarketCount = polyResult.value.length;
        polyError = null;
      } else {
        polyError = polyResult.reason?.message || 'Failed to fetch Polymarket markets';
        console.error('[Market Cache] Polymarket fetch failed:', polyError);
      }

      // Stage 0: Track Kalshi fetch
      if (kalshiResult.status === 'fulfilled') {
        kalshiTimestamp = now;
        kalshiMarketCount = kalshiResult.value.length;
        kalshiError = null;
      } else {
        kalshiError = kalshiResult.reason?.message || 'Failed to fetch Kalshi markets';
        console.error('[Market Cache] Kalshi fetch failed:', kalshiError);
      }

      const polyMarkets = polyResult.status === 'fulfilled' ? polyResult.value : [];
      const kalshiMarkets = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
      const merged = [...polyMarkets, ...kalshiMarkets];

      // Only overwrite if at least one source returned markets.
      if (merged.length > 0) {
        cachedMarkets = merged;
        cacheTimestamp = now;
      } else {
        console.warn('[Market Cache] Both sources empty/failed; preserving last known cache');
      }

      console.log(`[Market Cache] Cached ${cachedMarkets.length} markets (${polyMarkets.length} Poly + ${kalshiMarkets.length} Kalshi)`);
      return cachedMarkets;
    } catch (error) {
      console.error('[Market Cache] Failed to fetch markets:', error);
      // Return stale cache if available
      return cachedMarkets;
    } finally {
      inFlightFetch = null;
    }
  })();
  return inFlightFetch;
}

/**
 * Stage 0: Get freshness metadata for current cached data
 * Tells bots/agents how old the data is and which sources are healthy
 *
 * @returns FreshnessMetadata with data age and source health status
 */
export function getMarketMetadata(): FreshnessMetadata {
  const now = Date.now();

  // Find oldest fetch timestamp (or use cache timestamp if no individual source timestamps)
  const oldestTimestamp = Math.min(
    polyTimestamp || cacheTimestamp,
    kalshiTimestamp || cacheTimestamp
  );

  // Calculate data age in seconds
  const dataAgeMs = now - oldestTimestamp;
  const dataAgeSeconds = Math.floor(dataAgeMs / 1000);

  // Build source status
  const polymarketStatus: SourceStatus = {
    available: polyError === null && polyMarketCount > 0,
    last_successful_fetch: polyTimestamp > 0 ? new Date(polyTimestamp).toISOString() : null,
    error: polyError || undefined,
    market_count: polyMarketCount,
  };

  const kalshiStatus: SourceStatus = {
    available: kalshiError === null && kalshiMarketCount > 0,
    last_successful_fetch: kalshiTimestamp > 0 ? new Date(kalshiTimestamp).toISOString() : null,
    error: kalshiError || undefined,
    market_count: kalshiMarketCount,
  };

  return {
    data_age_seconds: dataAgeSeconds,
    fetched_at: new Date(oldestTimestamp).toISOString(),
    sources: {
      polymarket: polymarketStatus,
      kalshi: kalshiStatus,
    },
  };
}

/**
 * Get cached arbitrage opportunities
 *
 * Caches with low minSpread (0.01) and filters client-side.
 * This allows different callers to request different thresholds
 * without recomputing the expensive O(n×m) scan.
 *
 * @param minSpread - Minimum spread threshold (default: 0.03)
 * @returns Arbitrage opportunities filtered by minSpread
 */
export async function getArbitrage(minSpread: number = 0.03): Promise<ArbitrageOpportunity[]> {
  const markets = await getMarkets();
  const now = Date.now();

  // Recompute when TTL expired or when the underlying market snapshot changed.
  const ttlStale = arbCacheMarketsStamp < 0 || (now - arbCacheTimestamp) >= ARB_CACHE_TTL_MS;
  const marketsMoved = arbCacheMarketsStamp !== cacheTimestamp;
  if (ttlStale || marketsMoved) {
    console.log('[Arbitrage Cache] Computing arbitrage opportunities...');
    // Cache with low threshold (0.01) so we can filter client-side
    cachedArbitrage = detectArbitrage(markets, 0.01);
    arbCacheTimestamp = now;
    arbCacheMarketsStamp = cacheTimestamp;
    console.log(`[Arbitrage Cache] Cached ${cachedArbitrage.length} opportunities (minSpread: 0.01, TTL: ${ARB_CACHE_TTL_MS}ms)`);
  }

  // Filter cached results by requested minSpread
  const filtered = cachedArbitrage.filter(arb => arb.spread >= minSpread);
  console.log(`[Arbitrage Cache] Returning ${filtered.length}/${cachedArbitrage.length} opportunities (minSpread: ${minSpread})`);

  return filtered;
}
