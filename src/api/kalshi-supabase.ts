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

function isSimpleMarket(row: SupabaseMarketRow): boolean {
  if (!row.title || !row.platform_id) return false;
  if (/MULTIGAME|MVE/i.test(row.platform_id)) return false;
  if (/^yes\s/i.test(row.title.trim())) return false;
  const commas = (row.title.match(/,/g) || []).length;
  if (commas > 2) return false;
  return true;
}

function toMarket(row: SupabaseMarketRow): Market {
  const yesPrice = Math.min(Math.max(row.yes_price ?? 0.5, 0.01), 0.99);
  const noPrice = +((1 - yesPrice).toFixed(2));

  return {
    id: row.id,
    platform: 'kalshi',
    title: row.title,
    description: row.description ?? '',
    keywords: generateKeywords(row.title),
    yesPrice: +yesPrice.toFixed(2),
    noPrice,
    volume24h: row.volume_24h ?? 0,
    url: row.url,
    category: row.category ?? 'other',
    lastUpdated: row.last_ingested_at ?? new Date().toISOString(),
    endDate: row.closes_at ?? undefined,
  };
}

export async function fetchKalshiMarketsFromSupabase(
  targetCount = 1000,
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
      .eq('platform', 'kalshi')
      .eq('status', 'open')
      .eq('is_active', true)
      .is('source_missing_at', null)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`[Kalshi Supabase] Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    const simple = (data as SupabaseMarketRow[])
      .filter(isSimpleMarket)
      .filter((row) => row.yes_price > 0 && row.yes_price < 1)
      .map(toMarket);

    results.push(...simple);

    console.log(
      `[Kalshi Supabase] Page from=${from}: ${data.length} raw → ${simple.length} simple (total: ${results.length})`,
    );

    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`[Kalshi Supabase] Fetched ${results.length} markets from Supabase`);
  return results;
}
