/**
 * test-arbitrage-detector.ts
 *
 * Tests areMarketsSimilar() logic against known true-positive and false-positive pairs.
 * Run with:  npx ts-node test-arbitrage-detector.ts
 *
 * Tests both the OLD detector and the NEW detector side by side so you can
 * see exactly what each version does with the same inputs.
 */

// Inlined from src/types/market.ts to avoid ESM import issues
interface Market {
  id: string;
  platform: 'kalshi' | 'polymarket';
  title: string;
  description: string;
  keywords: string[];
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  url: string;
  category: string;
  lastUpdated: string;
  numericId?: string;
  oneDayPriceChange?: number;
  endDate?: string;
}

// ─── Inline the OLD detector logic ───────────────────────────────────────────

function OLD_normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\?/g, '')
    .replace(/\b(will|before|after|by|in|on|at|the|a|an)\b/g, '')
    .replace(/\b(2024|2025|2026|2027|2028)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function OLD_extractEntities(title: string): Set<string> {
  const normalized = OLD_normalizeTitle(title);
  const words = normalized.split(' ');
  const entities = new Set<string>();
  const stopWords = new Set(['will', 'hit', 'reach', 'win', 'lose', 'pass', 'than', 'over', 'under']);
  for (const word of words) {
    if (word.length >= 3 && !stopWords.has(word)) {
      entities.add(word);
    }
  }
  return entities;
}

function OLD_calculateTitleSimilarity(title1: string, title2: string): number {
  const entities1 = OLD_extractEntities(title1);
  const entities2 = OLD_extractEntities(title2);
  if (entities1.size === 0 || entities2.size === 0) return 0;
  let sharedCount = 0;
  for (const entity of entities1) {
    if (entities2.has(entity)) sharedCount++;
  }
  const union = entities1.size + entities2.size - sharedCount;
  return union > 0 ? sharedCount / union : 0;
}

function OLD_calculateKeywordOverlap(market1: Market, market2: Market): number {
  const keywords1 = new Set(market1.keywords);
  const keywords2 = new Set(market2.keywords);
  let overlap = 0;
  for (const kw of keywords1) {
    if (keywords2.has(kw)) overlap++;
  }
  return overlap;
}

function OLD_areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean; confidence: number; reason: string;
} {
  const categoryMatch =
    poly.category === kalshi.category ||
    poly.category === 'other' ||
    kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  const titleSim = OLD_calculateTitleSimilarity(poly.title, kalshi.title);
  const keywordOverlap = OLD_calculateKeywordOverlap(poly, kalshi);

  if (titleSim > 0.5) {
    return {
      isSimilar: true,
      confidence: titleSim,
      reason: `High title similarity (${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  if (keywordOverlap >= 3) {
    const confidence = Math.min(keywordOverlap / 10, 0.9);
    return {
      isSimilar: true,
      confidence,
      reason: `${keywordOverlap} shared keywords`,
    };
  }

  const polyEntities = OLD_extractEntities(poly.title);
  const kalshiEntities = OLD_extractEntities(kalshi.title);
  const sharedEntities = Array.from(polyEntities).filter(e => kalshiEntities.has(e));

  if (sharedEntities.length >= 2 && titleSim > 0.3) {
    return {
      isSimilar: true,
      confidence: 0.7,
      reason: `Shared entities: ${sharedEntities.slice(0, 3).join(', ')}`,
    };
  }

  return { isSimilar: false, confidence: 0, reason: 'Insufficient similarity' };
}

// ─── Inline the NEW detector logic ───────────────────────────────────────────

const GENERIC_WORDS = new Set([
  'will', 'does', 'is', 'are', 'was', 'were', 'can', 'could', 'would', 'should',
  'who', 'what', 'when', 'where', 'which', 'how', 'many',
  'the', 'a', 'an', 'in', 'on', 'at', 'by', 'to', 'of', 'for',
  'from', 'with', 'into', 'than', 'over', 'under', 'before', 'after',
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
  '2024', '2025', '2026', '2027', '2028',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'basketball', 'football', 'baseball', 'soccer', 'hockey', 'tennis',
  'nba', 'nfl', 'mlb', 'nhl', 'mls',
  'pro', 'big', 'new', 'old', 'top', 'its', 'get',
]);

const MIN_NAMED_JACCARD = 0.25;
const MIN_NAMED_OVERLAP_COUNT = 2;

function NEW_tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

/**
 * Minimal suffix stemmer for prediction market titles.
 * Strips common inflection suffixes so impeach/impeachment/impeached
 * all collapse to the same root token.
 */
function stem(word: string): string {
  return word
    .replace(/ments?$/, '')   // impeachment → impeach
    .replace(/ations?$/, '')  // nomination → nomin
    .replace(/ings?$/, '')    // winning → winn
    .replace(/ness$/, '')     // fitness → fit
    .replace(/ers?$/, '')     // winners → winn
    .replace(/ed$/, '')       // elected → elect
    .replace(/ly$/, '')       // quickly → quick
    .replace(/s$/, '');       // elections → election (last, least aggressive)
}

function NEW_namedTokens(title: string): Set<string> {
  return new Set(
    NEW_tokenize(title)
      .map(stem)
      .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w))
  );
}

function NEW_jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function NEW_areMarketsSimilar(poly: Market, kalshi: Market): {
  isSimilar: boolean; confidence: number; reason: string;
} {
  const categoryMatch =
    poly.category === kalshi.category ||
    poly.category === 'other' ||
    kalshi.category === 'other';

  if (!categoryMatch) {
    return { isSimilar: false, confidence: 0, reason: 'Different categories' };
  }

  const polyNamed = NEW_namedTokens(poly.title);
  const kalshiNamed = NEW_namedTokens(kalshi.title);

  if (polyNamed.size === 0 || kalshiNamed.size === 0) {
    return { isSimilar: false, confidence: 0, reason: 'No named tokens extracted' };
  }

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

  const sim = NEW_jaccard(polyNamed, kalshiNamed);
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

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<Market> & Pick<Market, 'platform' | 'title' | 'category' | 'yesPrice'>): Market {
  return {
    id: Math.random().toString(36).slice(2),
    description: '',
    keywords: overrides.keywords ?? [],
    noPrice: 1 - overrides.yesPrice,
    volume24h: 50000,
    url: 'https://example.com',
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

const fp_poly = makeMarket({
  platform: 'polymarket',
  title: 'Will Knicks win the 2026 NBA Finals 4-3?',
  category: 'sports',
  yesPrice: 0.15,
  keywords: ['knicks', 'nba', 'finals', 'new', 'york', 'san', 'antonio', 'basketball'],
});

const fp_kalshi = makeMarket({
  platform: 'kalshi',
  title: 'Will Taylor Swift attend Pro Basketball Finals Game 4?',
  category: 'sports',
  yesPrice: 0.96,
  keywords: ['taylor', 'swift', 'finals', 'game', 'basketball', 'york', 'san', 'antonio'],
});

const tp_poly = makeMarket({
  platform: 'polymarket',
  title: 'Will Donald Trump be impeached before January 2027?',
  category: 'politics',
  yesPrice: 0.12,
  keywords: ['trump', 'impeach', 'congress', 'president'],
});

const tp_kalshi = makeMarket({
  platform: 'kalshi',
  title: 'Trump impeachment by end of 2026?',
  category: 'politics',
  yesPrice: 0.19,
  keywords: ['trump', 'impeachment', 'political'],
});

const edge_poly = makeMarket({
  platform: 'polymarket',
  title: 'Will the Lakers win the 2026 NBA Championship?',
  category: 'sports',
  yesPrice: 0.08,
  keywords: ['lakers', 'nba', 'championship', 'basketball'],
});

const edge_kalshi = makeMarket({
  platform: 'kalshi',
  title: 'Will the Celtics win the NBA Finals in 2026?',
  category: 'sports',
  yesPrice: 0.22,
  keywords: ['celtics', 'nba', 'finals', 'basketball'],
});

const cat_poly = makeMarket({
  platform: 'polymarket',
  title: 'Will Elon Musk acquire another major media company?',
  category: 'business',
  yesPrice: 0.30,
  keywords: ['musk', 'media', 'acquisition'],
});

const cat_kalshi = makeMarket({
  platform: 'kalshi',
  title: 'Will Elon Musk acquire another major media company?',
  category: 'entertainment',
  yesPrice: 0.33,
  keywords: ['musk', 'media', 'acquisition'],
});

// ─── Runner ───────────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  poly: Market;
  kalshi: Market;
  expectedMatch: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    name: 'FALSE POSITIVE — Knicks vs Taylor Swift (June 10 audit)',
    poly: fp_poly,
    kalshi: fp_kalshi,
    expectedMatch: false,
  },
  {
    name: 'TRUE POSITIVE  — Trump impeachment (same event, different wording)',
    poly: tp_poly,
    kalshi: tp_kalshi,
    expectedMatch: true,
  },
  {
    name: 'EDGE CASE      — Lakers vs Celtics (different teams, same sport)',
    poly: edge_poly,
    kalshi: edge_kalshi,
    expectedMatch: false,
  },
  {
    name: 'EDGE CASE      — Identical title, different categories',
    poly: cat_poly,
    kalshi: cat_kalshi,
    expectedMatch: false,
  },
];

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

let totalPassed = 0;
let totalFailed = 0;

for (const tc of TEST_CASES) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`TEST: ${tc.name}`);
  console.log(`  Poly:   "${tc.poly.title}" @ ${tc.poly.yesPrice}`);
  console.log(`  Kalshi: "${tc.kalshi.title}" @ ${tc.kalshi.yesPrice}`);
  console.log(`  Expected match: ${tc.expectedMatch}`);
  console.log('');

  const oldResult = OLD_areMarketsSimilar(tc.poly, tc.kalshi);
  const oldCorrect = oldResult.isSimilar === tc.expectedMatch;
  console.log(`  OLD → isSimilar=${oldResult.isSimilar}  confidence=${oldResult.confidence.toFixed(2)}  reason="${oldResult.reason}"`);
  console.log(`        ${oldCorrect ? PASS : FAIL}`);

  const newResult = NEW_areMarketsSimilar(tc.poly, tc.kalshi);
  const newCorrect = newResult.isSimilar === tc.expectedMatch;
  console.log(`  NEW → isSimilar=${newResult.isSimilar}  confidence=${newResult.confidence.toFixed(2)}  reason="${newResult.reason}"`);
  console.log(`        ${newCorrect ? PASS : FAIL}`);

  if (newCorrect) totalPassed++; else totalFailed++;
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`NEW detector: ${totalPassed}/${TEST_CASES.length} passed  (${totalFailed} failed)`);
console.log('═'.repeat(70));