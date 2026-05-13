create table if not exists public.analyzed_tweets (
  tweet_id              text primary key,
  author                text not null,
  category              text not null,
  urgency               text not null check (urgency in ('low','medium','high','critical')),
  confidence            numeric(5,4) not null check (confidence >= 0 and confidence <= 1),
  tweet_created_at      timestamptz not null,
  collected_at          timestamptz not null,
  analyzed_at           timestamptz not null,
  tweet_json            jsonb not null,
  matches_json          jsonb not null default '[]'::jsonb,
  sentiment_json        jsonb not null,
  suggested_action_json jsonb,
  inserted_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_analyzed_tweets_created
  on public.analyzed_tweets (tweet_created_at desc);
create index if not exists idx_analyzed_tweets_category_created
  on public.analyzed_tweets (category, tweet_created_at desc);
create index if not exists idx_analyzed_tweets_urgency_created
  on public.analyzed_tweets (urgency, tweet_created_at desc);
create index if not exists idx_analyzed_tweets_author_created
  on public.analyzed_tweets (author, tweet_created_at desc);

drop trigger if exists trg_analyzed_tweets_updated_at on public.analyzed_tweets;
create trigger trg_analyzed_tweets_updated_at
before update on public.analyzed_tweets
for each row execute function public.set_updated_at();

alter table public.analyzed_tweets enable row level security;
-- No policies: anon/authenticated default-deny. Service role bypasses RLS.
