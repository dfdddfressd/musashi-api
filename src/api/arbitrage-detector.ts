// Cross-platform arbitrage detector
// Matches markets across Polymarket and Kalshi to find price discrepancies

import { Market, ArbitrageOpportunity } from '../types/market';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Words that appear in many prediction market titles but carry no
 * discriminating signal. A match on only these words is meaningless.
 */
const GENERIC_WORDS = new Set([
  // Question scaffolding
  'will', 'does', 'is', 'are', 'was', 'were', 'can', 'could', 'would', 'should',
  'who', 'what', 'when', 'where', 'which', 'how', 'many',
  // Prepositions / articles
  'the', 'a', 'an', 'in', 'on', 'at', 'by', 'to', 'of', 'for',
  'from', 'with', 'into', 'than', 'over', 'under', 'before', 'after',
  // Generic event/outcome words — these are the main offenders
  'win', 'wins', 'winner', 'winning', 'lose', 'loss', 'losses',
  'game', 'games', 'match', 'matches', 'series', 'season',
  'finals', 'final', 'championship', 'title', 'trophy',
  'cup', 'bowl', 'open', 'classic', 'tournament', 'league',
  'sport', 'sports', 'team', 'player', 'players',
  'market', 'resolve', 'resolves', 'resolved', 'yes', 'no',
  'hit', 'reach', 'pass', 'beat', 'top', 'lead',
  'first', 'second', 'third', 'next', 'last',
  'attend', 'attending', 'appear', 'appears',
  'announce', 'announces', 'sign', 'signs',
  // Numbers / dates
  '2024', '2025', '2026', '2027', '2028',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  // Sports-generic (sport names alone are not enough)
  'basketball', 'football', 'baseball', 'soccer', 'hockey', 'tennis',
  'nba', 'nfl', 'mlb', 'nhl', 'mls',
  // Short noise
  'pro', 'big', 'new', 'old', 'top', 'its', 'get',
]);

/**
 * Minimum Jaccard similarity on NAMED tokens (those not in GENERIC_WORDS)
 * to consider two markets the same event.
 * 0.25 means at least 1-in-4 meaningful words must overlap.
 * Set deliberately conservative — false negatives are cheaper than false positives.
 */
const MIN_NAMED_JACCARD = 0.25;

/**
 * We also require at least this many named tokens to overlap in absolute terms.
 * Prevents 1/1 = 1.0 Jaccard on trivially short titles.
 */
const MIN_NAMED_OVERLAP_COUNT = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}


function stem(word: string): string {
  return word
    .replace(/ments?$/, '')
    .replace(/ations?$/, '')
    .replace(/ings?$/, '')
    .replace(/ness$/, '')
    .replace(/ers?$/, '')
    .replace(/ed$/, '')
    .replace(/ly$/, '')
    .replace(/s$/, '');
}

/**
 * Returns only the tokens that carry discriminating signal —
 * i.e., tokens not in GENERIC_WORDS.
 * These are the named entities / specific nouns we care about.
 */
function namedTokens(title: string): Set<string> {
  return new Set(
    tokenize(title)
      .map(stem)
      .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w))
  );
}

/**
 * Jaccard similarity over two sets.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}


/**
 * Normalize a title for fuzzy matching
 * Removes punctuation, dates, common question words, normalizes spacing
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\?/g, '') // Remove question marks
    .replace(/\b(will|before|after|by|in|on|at|the|a|an)\b/g, '') // Remove filler words
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '') // Remove years
    .replace(/[^a-z0-9\s]/g, ' ') // Remove all punctuation
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/**
 * Extract key entities from a market title
 * Looks for: names, tickers, numbers, organizations
 */
function extractEntities(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const words = normalized.split(' ');
  const entities = new Set<string>();

  // Extract significant words (3+ chars, not in stop list)
  const stopWords = new Set(['will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under']);

  for (const word of words) {
    if (word.length >= 3 && !stopWords.has(word)) {
      entities.add(word);
    }
  }

  return entities;
}

/**
 * Calculate similarity score between two titles
 * Returns 0-1 based on shared entities
 */
function calculateTitleSimilarity(title1: string, title2: string): number {
  const entities1 = extractEntities(title1);
  const entities2 = extractEntities(title2);

  if (entities1.size === 0 || entities2.size === 0) return 0;

  // Count shared entities
  let sharedCount = 0;
  for (const entity of entities1) {
    if (entities2.has(entity)) {
      sharedCount++;
    }
  }

  // Jaccard similarity: intersection / union
  const union = entities1.size + entities2.size - sharedCount;
  return union > 0 ? sharedCount / union : 0;
}

/**
 * Calculate keyword overlap between two markets
 * Returns the number of shared keywords
 */
function calculateKeywordOverlap(market1: Market, market2: Market): number {
  const keywords1 = new Set(market1.keywords);
  const keywords2 = new Set(market2.keywords);

  let overlap = 0;
  for (const kw of keywords1) {
    if (keywords2.has(kw)) {
      overlap++;
    }
  }

  return overlap;
}

/**
 * Check if two markets refer to the same event
 *
 * Requirements (ALL must pass):
 *   1. Category must be compatible (same, or one is 'other')
 *   2. Named-token overlap must be >= MIN_NAMED_OVERLAP_COUNT (absolute)
 *   3. Named-token Jaccard must be >= MIN_NAMED_JACCARD
 *
 * Confidence is the raw Jaccard score (0–1). The API floor of 0.5 is gone —
 * a match at Jaccard 0.26 will report confidence 0.26, letting callers decide.
 */

function areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean;
  confidence: number;
  reason: string;
} {
  // Must be in the same category (or one is 'other')
  const categoryMatch = poly.category === kalshi.category ||
                       poly.category === 'other' ||
                       kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

    // 2. Named-token extraction
  const polyNamed = namedTokens(poly.title);
  const kalshiNamed = namedTokens(kalshi.title);

  if (polyNamed.size === 0 || kalshiNamed.size === 0) {
    return { isSimilar: false, confidence: 0, reason: 'No named tokens extracted' };
  }

  // 3. Absolute overlap count
  const overlapTokens: string[] = [];
  for (const token of polyNamed) {
    if (kalshiNamed.has(token)) overlapTokens.push(token);
  }

  if (overlapTokens.length < MIN_NAMED_OVERLAP_COUNT) {
    return {
      isSimilar: false,
      confidence: 0,
      reason: `Only ${overlapTokens.length} named token(s) overlap (need ${MIN_NAMED_OVERLAP_COUNT})`,
    };
  }


  // 4. Jaccard gate
  const sim = jaccard(polyNamed, kalshiNamed);
  if (sim < MIN_NAMED_JACCARD) {
    return {
      isSimilar: false,
      confidence: 0,
      reason: `Named Jaccard ${sim.toFixed(2)} below threshold ${MIN_NAMED_JACCARD}`,
    };
  }

  return {
    isSimilar: true,
    confidence: sim,
    reason: `Named tokens: [${overlapTokens.slice(0, 4).join(', ')}] — Jaccard ${sim.toFixed(2)}`,
  };
}


/**
 * Detect arbitrage opportunities across Polymarket and Kalshi
 *
 * @param markets - Combined array of markets from both platforms
 * @param minSpread - Minimum spread to be considered an opportunity (default: 0.03 = 3%)
 * @returns Array of arbitrage opportunities sorted by spread (highest first)
 */
export function detectArbitrage(
  markets: Market[],
  minSpread: number = 0.03
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  // Separate markets by platform
  const polymarkets = markets.filter(m => m.platform === 'polymarket');
  const kalshiMarkets = markets.filter(m => m.platform === 'kalshi');

  console.log(`[Arbitrage] Checking ${polymarkets.length} Polymarket × ${kalshiMarkets.length} Kalshi markets`);

  // Compare each Polymarket market with each Kalshi market
  for (const poly of polymarkets) {
    for (const kalshi of kalshiMarkets) {
      const similarity = areMarketsSimilar(poly, kalshi);

      if (!similarity.isSimilar) continue;

      // Calculate spread
      const spread = Math.abs(poly.yesPrice - kalshi.yesPrice);

      if (spread < minSpread) continue;

      // Determine direction and profit potential
      const direction: ArbitrageOpportunity['direction'] =
        poly.yesPrice < kalshi.yesPrice
          ? 'buy_poly_sell_kalshi'
          : 'buy_kalshi_sell_poly';

      opportunities.push({
        polymarket: poly,
        kalshi: kalshi,
        spread,
        profitPotential: spread,
        direction,
        confidence: similarity.confidence,
        matchReason: similarity.reason,
      });
    }
  }

  // Sort by spread (highest first)
  opportunities.sort((a, b) => b.spread - a.spread);

  console.log(`[Arbitrage] Found ${opportunities.length} opportunities (min spread: ${minSpread})`);

  return opportunities;
}

/**
 * Get top arbitrage opportunities
 * Filters by minimum spread and confidence, returns top N
 */
export function getTopArbitrage(
  markets: Market[],
  options: {
    minSpread?: number;
    minConfidence?: number;
    limit?: number;
    category?: string;
  } = {}
): ArbitrageOpportunity[] {
  const {
    minSpread = 0.03,
    minConfidence = 0.5,
    limit = 20,
    category,
  } = options;

  let opportunities = detectArbitrage(markets, minSpread);

  // Filter by confidence
  opportunities = opportunities.filter(op => op.confidence >= minConfidence);

  // Filter by category if specified
  if (category) {
    opportunities = opportunities.filter(
      op => op.polymarket.category === category || op.kalshi.category === category
    );
  }

  // Return top N
  return opportunities.slice(0, limit);
}
