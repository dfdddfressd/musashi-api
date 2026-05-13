import { after, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalyzedTweet, ArchiveResult } from '../src/types/feed';

const SUPABASE_ENV_ERROR =
  'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for server-side Supabase access';

type MockUpsertResult = {
  error: null | { message: string };
};

type MockClient = {
  from: (table: string) => {
    upsert: (rows: unknown[], opts: unknown) => Promise<MockUpsertResult>;
  };
};

function makeTweet(id: string): AnalyzedTweet {
  return {
    tweet: {
      id,
      text: `tweet text ${id}`,
      author: '@testuser',
      created_at: '2026-05-12T00:00:00.000Z',
      metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0 },
      url: `https://twitter.com/testuser/status/${id}`,
    },
    matches: [],
    sentiment: { score: 0, label: 'neutral' } as unknown as import('../src/analysis/sentiment-analyzer').SentimentResult,
    category: 'crypto',
    urgency: 'low',
    confidence: 0.5,
    analyzed_at: '2026-05-12T00:00:00.000Z',
    collected_at: '2026-05-12T00:00:00.000Z',
  };
}

function makeMockClient(
  upsert: (rows: unknown[], opts: unknown) => Promise<MockUpsertResult>,
): MockClient {
  return {
    from: () => ({ upsert }),
  };
}

let clientFactory: (() => MockClient | null) = () => null;

describe('archiveAnalyzedTweets', () => {
  let archiveAnalyzedTweets: (tweets: AnalyzedTweet[]) => Promise<ArchiveResult>;

  before(async () => {
    // Set up mock once before the module is first imported
    mock.module('../src/api/supabase-server-client', {
      namedExports: {
        getServerSupabase: () => {
          const client = clientFactory();
          if (!client) {
            throw new Error(SUPABASE_ENV_ERROR);
          }
          return client;
        },
        resetServerSupabaseForTests: () => {},
      },
    });
    // Import after mock is registered so the archive module captures the mocked getServerSupabase
    ({ archiveAnalyzedTweets } = await import('../src/api/analyzed-tweet-archive'));
  });

  after(() => mock.restoreAll());

  beforeEach(() => {
    clientFactory = () => null;
  });

  describe('empty input short-circuit', () => {
    it('returns zeros without initialising the client', async () => {
      let initCalled = false;
      clientFactory = () => {
        initCalled = true;
        return null!;
      };

      const result = await archiveAnalyzedTweets([]);

      assert.deepEqual(result, { attempted: 0, upserted: 0, failed: 0, errors: [] });
      assert.equal(initCalled, false);
    });
  });

  describe('upsert shape', () => {
    const upsertCalls: Array<{ rows: unknown[]; opts: unknown }> = [];

    beforeEach(() => {
      upsertCalls.length = 0;
      clientFactory = () =>
        makeMockClient((rows: unknown[], opts: unknown) => {
          upsertCalls.push({ rows, opts });
          return Promise.resolve({ error: null });
        });
    });

    it('calls upsert with onConflict tweet_id', async () => {
      const result = await archiveAnalyzedTweets([makeTweet('abc1')]);
      assert.equal(result.attempted, 1);
      assert.equal(result.upserted, 1);
      assert.equal(result.failed, 0);
      assert.equal(upsertCalls.length, 1);
      assert.deepEqual(upsertCalls[0].opts, { onConflict: 'tweet_id' });
    });

    it('produces one upsert call per invocation (DB deduplication is the contract)', async () => {
      await archiveAnalyzedTweets([makeTweet('abc2')]);
      await archiveAnalyzedTweets([makeTweet('abc2')]);
      assert.equal(upsertCalls.length, 2);
    });

    it('includes updated_at as a valid ISO string close to the archive time', async () => {
      const before = Date.now();
      await archiveAnalyzedTweets([makeTweet('upd1')]);
      const after = Date.now();

      const row = upsertCalls[0].rows[0] as Record<string, unknown>;
      assert.equal(typeof row.updated_at, 'string', 'updated_at should be a string');
      const ts = Date.parse(row.updated_at as string);
      assert.ok(!isNaN(ts), 'updated_at should be a parseable ISO string');
      assert.ok(ts >= before && ts <= after + 50, 'updated_at should reflect the archive time');
    });
  });

  describe('Supabase error path', () => {
    it('resolves with failures instead of throwing', async () => {
      clientFactory = () => makeMockClient(() => Promise.resolve({ error: { message: 'boom' } }));

      const result = await archiveAnalyzedTweets([makeTweet('err1')]);
      assert.equal(result.attempted, 1);
      assert.equal(result.upserted, 0);
      assert.equal(result.failed, 1);
      assert.deepEqual(result.errors, ['boom']);
    });
  });

  describe('missing env vars (getServerSupabase throws)', () => {
    it('returns ArchiveResult with all tweets failed, does not throw', async () => {
      clientFactory = () => null; // triggers the throw in the mock

      const tweets = [makeTweet('env1'), makeTweet('env2')];
      const result = await archiveAnalyzedTweets(tweets);
      assert.equal(result.attempted, 2);
      assert.equal(result.failed, 2);
      assert.equal(result.upserted, 0);
      assert.equal(result.errors.length, 1);
    });
  });

  describe('error cap at 5', () => {
    it('caps errors array at 5 entries across batches', async () => {
      let callCount = 0;
      clientFactory = () =>
        makeMockClient(() => {
          const msg = `error-${callCount++}`;
          return Promise.resolve({ error: { message: msg } });
        });

      const tweets = Array.from({ length: 601 }, (_, i) => makeTweet(`cap-${i}`));
      const result = await archiveAnalyzedTweets(tweets);
      assert.equal(result.errors.length, 5);
      assert.equal(result.failed, tweets.length);
    });
  });
});
