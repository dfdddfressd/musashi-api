import { getServerSupabase } from './supabase-server-client';
import type { AnalyzedTweetInsert } from './supabase-server-client';
import type { AnalyzedTweet, ArchiveResult } from '../types/feed';

const BATCH_SIZE = 100;

function toInsertRow(tweet: AnalyzedTweet): AnalyzedTweetInsert {
  return {
    tweet_id: tweet.tweet.id,
    author: tweet.tweet.author,
    category: tweet.category,
    urgency: tweet.urgency,
    confidence: tweet.confidence,
    tweet_created_at: tweet.tweet.created_at,
    collected_at: tweet.collected_at,
    analyzed_at: tweet.analyzed_at,
    updated_at: new Date().toISOString(),
    tweet_json: tweet.tweet as unknown as Record<string, unknown>,
    matches_json: tweet.matches as unknown[],
    sentiment_json: tweet.sentiment as unknown as Record<string, unknown>,
    suggested_action_json: tweet.suggested_action
      ? (tweet.suggested_action as unknown as Record<string, unknown>)
      : null,
  };
}

export async function archiveAnalyzedTweets(tweets: AnalyzedTweet[]): Promise<ArchiveResult> {
  if (tweets.length === 0) {
    return { attempted: 0, upserted: 0, failed: 0, errors: [] };
  }

  let supabase: ReturnType<typeof getServerSupabase>;
  try {
    supabase = getServerSupabase();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Supabase client init failed';
    return {
      attempted: tweets.length,
      upserted: 0,
      failed: tweets.length,
      errors: [msg],
    };
  }

  let upserted = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < tweets.length; i += BATCH_SIZE) {
    const batch = tweets.slice(i, i + BATCH_SIZE);
    const rows = batch.map(toInsertRow);

    try {
      const { error } = await supabase
        .from('analyzed_tweets')
        .upsert(rows, { onConflict: 'tweet_id' });

      if (error) {
        failed += batch.length;
        if (errors.length < 5) errors.push(error.message);
      } else {
        upserted += batch.length;
      }
    } catch (err) {
      failed += batch.length;
      const msg = err instanceof Error ? err.message : 'Unknown upsert error';
      if (errors.length < 5) errors.push(msg);
    }
  }

  return { attempted: tweets.length, upserted, failed, errors };
}
