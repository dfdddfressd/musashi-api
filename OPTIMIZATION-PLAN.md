# Musashi API Tweet Collection Optimization Plan

## Objective

Adjust tweet collection so each monitored account is checked about every 15 minutes, keep recent feed data hot in Vercel KV, persist analyzed tweets to Supabase for long-term storage, reduce avoidable X API usage, and support adding more monitored accounts without changing any existing downstream consumers.

## Constraints

1. Only change `musashi-api`. Do not modify `musashi-mcp`, `musashi-extension`, trading bots, or any other downstream consumer.
2. Do not change the current public feed contract unless the change is strictly additive and existing callers continue to work unchanged.
3. Do not rely on KV expiration callbacks for archival. The current KV usage is TTL-based only and expired keys disappear without a guaranteed hook.
4. Keep the current downstream polling model. No SSE, webhook, or client migration is required in this plan.
5. Preserve the current feed semantics for recent tweets: KV remains the hot store for the latest feed and category indexes.
6. Add tests for any behavior change in cron collection, archival, or feed hydration.

## Current State

- Cron runs every 2 minutes via `/api/cron/collect-tweets`.
- High-priority accounts are rotated in batches; medium-priority accounts are currently disabled.
- The collector fetches the last 15 minutes of tweets for each selected account and stores only analyzed tweets that pass the confidence threshold.
- Stored tweets live in KV for 48 hours under `tweet:{tweetId}`.
- Twitter user IDs are cached in KV, but cache misses still trigger external API lookups.
- Feed indexes are rebuilt from KV after each cron run.
- Supabase is available in the project, but there is no table yet for archived analyzed tweets.

## Problems To Solve

1. The current per-account revisit cadence is about 10 minutes for 45 high-priority accounts, and that cadence will drift as accounts are added.
2. KV is acting as both the feed cache and the only persistence layer for analyzed tweets.
3. Using KV expiration as the archival trigger is not reliable.
4. Full KV scans for feed index rebuilds will become more expensive as the number of stored tweets grows.
5. Stable monitored accounts still incur avoidable user-ID lookup traffic on KV cache misses.
6. Tweet analysis results are not currently cached by tweet ID for reuse across compatible internal API paths.

## Proposed Design

### 1. Keep KV as the hot cache, add Supabase as the archive of record

Write analyzed tweets to Supabase at collection time, not at KV expiry time.

- `Supabase` stores the durable archive.
- `KV` stores the latest 48 hours for low-latency feed reads.
- The same tweet may be written multiple times by overlapping collection windows, so Supabase writes must use `upsert` keyed by `tweet_id`.

This preserves the current feed behavior while ensuring old tweets do not disappear once KV TTL expires.

### 2. Make the per-account refresh target explicit

Introduce a configurable target cadence for high-priority accounts.

- Example environment variable: `TWITTER_TARGET_REFRESH_MINUTES=15`
- Keep cron frequency independent from account count.
- Derive `ACCOUNTS_PER_BATCH` from:
  - number of active high-priority accounts
  - cron runs per target refresh window

If cron remains every 2 minutes, there are about 7.5 runs in 15 minutes. For 45 high-priority accounts, the batch size should be about 6 accounts per run to average a 15-minute revisit interval. As more accounts are added, the batch size should scale automatically instead of staying fixed at 10.

### 3. Preserve overlap or add cursor-based protection against misses

The current system avoids misses by revisiting accounts more frequently than the lookback window. If the target changes to about 15 minutes per account, a strict 15-minute lookback creates boundary risk.

Use one of these protections:

- Preferred: track a per-account cursor with `last_tweet_id` and `last_fetched_at`, then dedupe by `tweet_id`.
- Acceptable fallback: keep a modest overlap by fetching 18-20 minutes back while still deduping by `tweet_id`.

Because downstream must remain unchanged, this protection stays internal to the collector.

### 4. Expand monitored accounts without promoting everything to high priority

Support account growth by tiering collection frequency.

- `high` priority: target revisit about every 15 minutes
- `medium` priority: target revisit about every 30-60 minutes

This allows the monitored set to grow without forcing the most expensive schedule onto every account.

### 5. Keep feed reads on KV, use Supabase only for archival and backfill

The existing `/api/feed` contract should stay intact.

- Recent tweets continue to come from KV and KV-backed indexes.
- Archived tweet lookup can come from Supabase if a future API needs historical access.
- No downstream caller should be required to know whether a tweet came from KV or Supabase.

### 6. Replace repeated user-ID lookups with a static account ID registry

The monitored account set is curated and relatively stable, so account identity lookup should not depend on repeated API reads.

- Add a static `username -> userId` registry for curated accounts.
- Check the static registry before consulting KV or calling the external API.
- Keep KV lookup and API fetch as a fallback only for unmapped accounts.

This reduces avoidable X API usage without changing collection outputs or any downstream contract.

### 7. Cache `analyze-text` results per tweet ID

The cron collector already computes the same core analysis fields needed by `/api/analyze-text`.

- During cron storage, write a second KV entry such as `analyze:{tweetId}` alongside `tweet:{tweetId}`.
- Add additive support in `/api/analyze-text` to read from that cache when a `tweetId` is supplied.
- Preserve existing request behavior for current callers that only send `text`, `minConfidence`, and `maxResults`.

This keeps all current downstream consumers unchanged while making the cache path available for compatible internal usage.

## Schema Proposal

Add a new table, for example `public.analyzed_tweets`.

Suggested columns:

- `tweet_id text primary key`
- `author text not null`
- `category text not null`
- `created_at timestamptz not null`
- `collected_at timestamptz not null`
- `analyzed_at timestamptz not null`
- `urgency text not null`
- `confidence numeric not null`
- `tweet_json jsonb not null`
- `matches_json jsonb not null`
- `sentiment_json jsonb not null`
- `suggested_action_json jsonb`
- `inserted_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Suggested indexes:

- `created_at desc`
- `(category, created_at desc)`
- `(urgency, created_at desc)`

## Implementation Plan

### Phase 1. Add durable tweet storage

Files:

- `supabase/migrations/<new_migration>.sql`
- `src/api/supabase-client.ts`
- `api/cron/collect-tweets.ts`

Changes:

- Add the `analyzed_tweets` table and indexes in a new migration.
- Extend Supabase typings to include the new table.
- Add a server-side Supabase client path for service-role writes from cron.
- On each accepted `AnalyzedTweet`, `upsert` the row into Supabase before or alongside writing KV.

Verification:

- Migration applies cleanly.
- Reprocessing the same tweet updates one row instead of inserting duplicates.
- Cron still succeeds when writing both KV and Supabase.

### Phase 2. Eliminate repeated user-ID lookups

Files:

- `src/api/twitter-client.ts`
- optionally `src/data/twitter-accounts.ts`

Changes:

- Add a static user-ID registry for curated monitored accounts.
- Check the static registry before KV and external API lookup.
- Keep fallback behavior for any account that is not in the registry.

Verification:

- Known curated accounts resolve without an external user-ID fetch.
- Unknown accounts still resolve through the existing fallback path.

### Phase 3. Make collection cadence configurable

Files:

- `api/cron/collect-tweets.ts`
- optionally `src/types/feed.ts`

Changes:

- Replace the fixed `ACCOUNTS_PER_BATCH = 10` logic with dynamic batch sizing based on target refresh minutes.
- Keep account rotation in KV, but compute batch count from live account totals.
- Add internal metadata logging so each run reports effective revisit cadence.

Verification:

- With 45 high-priority accounts, the computed average revisit interval is about 15 minutes.
- With more accounts added, batch sizing adjusts automatically.

### Phase 4. Add collector-side miss protection

Files:

- `api/cron/collect-tweets.ts`
- `src/api/twitter-client.ts`
- optionally `src/types/feed.ts`

Changes:

- Add per-account cursor storage or extend the lookback overlap.
- Dedupe strictly by `tweet_id` before counting a tweet as newly archived.
- Keep the current downstream feed format unchanged.

Verification:

- Tweets posted near window boundaries are not lost.
- Repeated collection of the same tweet does not create duplicate Supabase rows.

### Phase 5. Cache `analyze-text` results per tweet

Files:

- `api/analyze-text.ts`
- `api/cron/collect-tweets.ts`

Changes:

- Write a per-tweet analysis cache entry such as `analyze:{tweetId}` during cron collection.
- Add an additive `tweetId` lookup path to `/api/analyze-text`.
- Preserve existing request handling when `tweetId` is not provided.

Verification:

- Cached analysis is returned when a known `tweetId` is supplied.
- Existing callers without `tweetId` continue to behave exactly as before.

### Phase 6. Re-enable and tier more accounts

Files:

- `src/data/twitter-accounts.ts`
- `api/cron/collect-tweets.ts`

Changes:

- Add more accounts to the curated list.
- Re-enable medium-priority collection with a slower schedule budget.
- Keep high-priority and medium-priority handling separate so account growth does not collapse high-priority freshness.

Verification:

- Added accounts are collected according to their tier.
- High-priority revisit time remains near target.

### Phase 7. Reduce index rebuild cost

Files:

- `api/cron/collect-tweets.ts`
- `api/feed.ts`
- `api/feed/stats.ts`

Changes:

- Replace full KV scans for every run with incremental updates to:
  - `feed:latest`
  - `feed:category:{category}`
- Keep the public `/api/feed` response unchanged.

Verification:

- Feed output matches current behavior for recent tweets.
- Cron runtime does not grow linearly with total archived tweet volume.

## Failure Handling

- If Supabase archival fails, the cron should decide explicitly whether to:
  - fail the whole run, or
  - continue serving hot-feed data from KV and surface an archival error in metadata

Recommended default:

- Treat KV write failure as critical for feed freshness.
- Treat Supabase write failure as an error that should be surfaced and alerted, but configurable whether it blocks the run.

This decision should be documented in code and covered by tests.

## Downstream Compatibility

This plan intentionally avoids downstream changes.

- No change required in `musashi-mcp`
- No change required in `musashi-extension`
- No change required in any bot poller
- No change required in request parameters to `/api/feed`
- No change required in existing `AnalyzedTweet` response shape for current consumers

Additive internal changes are allowed, but downstream callers must continue working without modification.

## Testing Plan

Run the smallest relevant `musashi-api` test set first, then broaden.

Suggested coverage:

1. Cron unit coverage for dynamic batch sizing and account rotation.
2. Static user-ID coverage proving curated accounts bypass external user lookup.
3. Cron archival coverage proving duplicate tweet collection results in a single archived row.
4. Feed coverage proving recent tweets still resolve from KV indexes.
5. Supabase integration coverage for insert, upsert, and readback of archived analyzed tweets.
6. Analyze-text cache coverage proving `tweetId` cache hits preserve existing fallback behavior.
7. Failure-path coverage for KV failure, Supabase failure, and mixed partial-write behavior.

## Out Of Scope

- Replacing polling with SSE
- Requiring existing callers to adopt new request parameters
- Changing downstream bot logic
- Rebuilding the feed API around Supabase-first reads
- Broad refactors unrelated to tweet collection and archival

## Recommended Delivery Order

1. Add the Supabase archive table and typings.
2. Add the static user-ID registry for curated accounts.
3. Write analyzed tweets to Supabase during cron collection.
4. Make the account revisit cadence configurable to about 15 minutes.
5. Add cursor or overlap protection to avoid boundary misses.
6. Add per-tweet `analyze-text` KV caching.
7. Expand the monitored account set by tier.
8. Optimize KV index maintenance once volume justifies it.
