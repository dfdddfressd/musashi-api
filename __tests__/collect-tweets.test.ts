import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const CRON_SECRET = 'test-secret';
const ACCOUNT_ROTATION_KEY = 'cron:account_batch';

// Mutable state shared between mock implementations and tests
let archiveShouldFail = false;
const kvSetCalls: Array<[string, unknown]> = [];
const setKvWithTtlCalls: Array<[string, number, unknown]> = [];

type CapturedResBody = { error: string } | { archive?: { failed: number } } | null;

type MockRes = {
  _captured: {
    statusCode: number;
    body: CapturedResBody;
  };
  setHeader: () => MockRes;
  status: (code: number) => MockRes;
  json: (body: CapturedResBody) => MockRes;
  end: () => MockRes;
};

function resetCallCaptures() {
  archiveShouldFail = false;
  kvSetCalls.length = 0;
  setKvWithTtlCalls.length = 0;
}

function makeMockReq() {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  };
}

function makeMockRes(): MockRes {
  const captured = { statusCode: 200, body: null as CapturedResBody };
  const res: MockRes = {
    _captured: captured,
    setHeader: () => res,
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: CapturedResBody) {
      captured.body = body;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

function findTweetKvWrites() {
  return setKvWithTtlCalls.filter(([key]) => key.startsWith('tweet:'));
}

function findRotationAdvance() {
  return kvSetCalls.find(([key]) => key === ACCOUNT_ROTATION_KEY);
}

function getLastRunMeta() {
  const metaCall = setKvWithTtlCalls.find(([key]) => key === 'cron:last_run');
  assert.ok(metaCall, 'expected cron:last_run to be stored');
  return metaCall[2] as { archive?: { failed: number } };
}

describe('collect-tweets cron handler', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: (req: any, res: any) => Promise<void>;

  before(async () => {
    process.env.CRON_SECRET = CRON_SECRET;

    mock.module('../src/data/twitter-accounts', {
      namedExports: {
        TWITTER_ACCOUNTS: [],
        getHighPriorityAccounts: () => [
          { username: 'testuser', category: 'crypto', priority: 'high', description: 'test account' },
        ],
        getMediumPriorityAccounts: () => [],
      },
    });

    mock.module('../api/lib/market-cache', {
      namedExports: {
        getMarkets: async () => [
          { id: 'mkt-1', title: 'Test Market', question: 'Will X happen?', outcomes: [] },
        ],
        getArbitrage: async () => [],
      },
    });

    mock.module('../src/analysis/keyword-matcher', {
      namedExports: {
        KeywordMatcher: class {
          match() {
            return [{ market: { id: 'mkt-1', title: 'Test Market' }, confidence: 0.5, keywords: [] }];
          }
        },
      },
    });

    mock.module('../src/analysis/sentiment-analyzer', {
      namedExports: {
        analyzeSentiment: () => ({ score: 0.1, label: 'neutral' }),
      },
    });

    mock.module('../src/analysis/signal-generator', {
      namedExports: {
        generateSignal: () => ({ urgency: 'medium', suggested_action: null }),
      },
    });

    mock.module('../src/api/twitter-client', {
      namedExports: {
        twitterClient: {
          batchFetchTimelines: async (usernames: string[]) => {
            const map = new Map<string, { tweets: unknown[]; error?: string }>();
            for (const username of usernames) {
              map.set(username, {
                tweets: [
                  {
                    id: `tweet-${username}-1`,
                    text: `test tweet from ${username}`,
                    author: `@${username}`,
                    created_at: '2026-05-12T00:00:00.000Z',
                    metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
                    url: `https://twitter.com/${username}/status/1`,
                  },
                ],
              });
            }
            return map;
          },
        },
      },
    });

    mock.module('../api/lib/vercel-kv', {
      namedExports: {
        kv: {
          get: async () => 0,
          set: async (key: string, val: unknown) => { kvSetCalls.push([key, val]); },
        },
        setKvWithTtl: async (key: string, ttl: number, val: unknown) => {
          setKvWithTtlCalls.push([key, ttl, val]);
        },
        listKvKeys: async () => [],
      },
    });

    mock.module('../api/lib/cache-helper', {
      namedExports: {
        batchGetFromKV: async () => [],
      },
    });

    mock.module('../src/api/analyzed-tweet-archive', {
      namedExports: {
        archiveAnalyzedTweets: async (tweets: unknown[]) => ({
          attempted: tweets.length,
          upserted: archiveShouldFail ? 0 : tweets.length,
          failed: archiveShouldFail ? tweets.length : 0,
          errors: archiveShouldFail ? ['archive error'] : [],
        }),
      },
    });

    // Import after all mocks are registered
    const mod = await import('../api/cron/collect-tweets');
    handler = mod.default;
  });

  after(() => {
    mock.restoreAll();
    delete process.env.CRON_SECRET;
    delete process.env.SUPABASE_ARCHIVE_REQUIRED;
  });

  beforeEach(() => {
    resetCallCaptures();
  });

  describe('best-effort mode', () => {
    it('returns 200 and advances rotation when archive fails', async () => {
      archiveShouldFail = true;
      process.env.SUPABASE_ARCHIVE_REQUIRED = 'false';

      const req = makeMockReq();
      const res = makeMockRes();
      await handler(req, res);

      assert.equal(res._captured.statusCode, 200);
      assert.ok(findTweetKvWrites().length > 0, 'expected at least one tweet: KV write');

      const meta = getLastRunMeta();
      assert.ok(meta.archive && meta.archive.failed > 0, 'expected archive.failed > 0 in metadata');
      assert.ok(findRotationAdvance(), 'expected rotation to advance in best-effort mode');
    });
  });

  describe('required mode', () => {
    it('returns 500 and holds rotation when archive fails', async () => {
      archiveShouldFail = true;
      process.env.SUPABASE_ARCHIVE_REQUIRED = 'true';

      const req = makeMockReq();
      const res = makeMockRes();
      await handler(req, res);

      assert.equal(res._captured.statusCode, 500);
      const body = res._captured.body as { error?: string };
      assert.equal(body.error, 'archive_failed');
      assert.ok(
        findTweetKvWrites().length > 0,
        'expected KV tweet writes even when archive fails with required mode',
      );
      assert.equal(
        findRotationAdvance(),
        undefined,
        'expected rotation to be held when archive fails in required mode',
      );
    });
  });
});
