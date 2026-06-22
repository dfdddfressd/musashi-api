/**
 * polymarket-supabase.ts
 *
 * Drop-in replacement for fetchPolymarkets() that reads from public.markets
 * in the musashi-infra Supabase database instead of hitting the Polymarket
 * gamma API live on every cache refresh.
 *
 * NOTE: As of the time this was written, public.markets contains zero rows
 * where platform = 'polymarket'. This file will work correctly but return
 * an empty array until the Polymarket ingestion pipeline (musashi-infra) is
 * built and running. The live API fallback in market-cache.ts handles that gap.
 *
 * Read-only — never writes or modifies any infra tables.
 */

import { Market } from '../types/market';
import { generateKeywords } from './keyword-generator';
import { getSupabaseClient } from '../../api/lib/supabase';

interface SupabaseMarketRow {
  id: string;
  platform_id: string;
  title: string;
  description: string | null;
  category: string;
  url: string;
  yes_price: number;
  no_price: number;
  volume_24h: number;
  closes_at: string | null;
  last_ingested_at: string | null;
}

const PAGE_SIZE = 1000;

/**
 * Mirrors isBinaryMarket() from polymarket-client.ts.
 * Filters out rows that look like multi-leg, parlay, or malformed markets.
 * The live client filters on parsed JSON outcomes — Supabase rows don't carry
 * raw outcome arrays, so we apply equivalent heuristics on title and platform_id.
 */
function isSimpleMarket(row: SupabaseMarketRow): boolean {
  if (!row.title || !row.platform_id) return false;
  // Polymarket multi-outcome markets often have comma-heavy titles
  const commas = (row.title.match(/,/g) || []).length;
  if (commas > 2) return false;
  return true;
}

/**
 * Maps a Supabase row to the internal Market type.
 * Mirrors toMarket() from polymarket-client.ts as closely as the schema allows:
 * - numericId: not stored in Supabase, omitted
 * - oneDayPriceChange: not stored in Supabase, omitted
 * - endDate: derived from closes_at
 * - keywords: generated from title the same way the live client does
 * - category: stored directly in Supabase (ingestion pipeline sets this),
 *   so no need to re-run inferCategory()
 */
function toMarket(row: SupabaseMarketRow): Market {
  const yesPrice = Math.min(Math.max(row.yes_price ?? 0.5, 0.01), 0.99);
  const noPrice = +((1 - yesPrice).toFixed(2));

  return {
    id: row.id,
    platform: 'polymarket',
    title: row.title,
    description: row.description ?? '',
    keywords: generateKeywords(row.title, row.description ?? undefined),
    yesPrice: +yesPrice.toFixed(2),
    noPrice,
    volume24h: row.volume_24h ?? 0,
    url: row.url,
    category: row.category ?? 'other',
    lastUpdated: row.last_ingested_at ?? new Date().toISOString(),
    endDate: row.closes_at ?? undefined,
  };
}

/**
 * Fetch active Polymarket binary markets from the musashi-infra Supabase database.
 * Paginates in 1000-row pages with a stable .order('id') to prevent skips/duplicates.
 * Filters to open, active, non-missing rows — same criteria as the Kalshi Supabase client.
 *
 * Returns an empty array (not an error) if no Polymarket rows exist yet.
 *
 * @param targetCount - Stop after collecting this many markets (default: 1200)
 */
export async function fetchPolymarketsFromSupabase(
  targetCount = 1200,
): Promise<Market[]> {
  const supabase = getSupabaseClient();
  const results: Market[] = [];
  let from = 0;

  while (results.length < targetCount) {
    const { data, error } = await supabase
      .from('markets')
      .select(
        'id, platform_id, title, description, category, url, yes_price, no_price, volume_24h, closes_at, last_ingested_at',
      )
      .eq('platform', 'polymarket')
      .eq('status', 'open')
      .eq('is_active', true)
      .is('source_missing_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`[Polymarket Supabase] Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    const simple = (data as SupabaseMarketRow[])
      .filter(isSimpleMarket)
      .filter((row) => row.yes_price > 0 && row.yes_price < 1)
      .map(toMarket);

    results.push(...simple);

    console.log(
      `[Polymarket Supabase] Page from=${from}: ${data.length} raw → ${simple.length} simple (total: ${results.length})`,
    );

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`[Polymarket Supabase] Fetched ${results.length} markets from Supabase`);
  return results;
}