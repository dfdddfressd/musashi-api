create extension if not exists pgcrypto;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  owner_label text,
  team_label text,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('api_request', 'signal_generated', 'trade_reported', 'trade_closed', 'api_error')),
  api_key_id uuid references public.api_keys(id) on delete set null,
  endpoint text,
  method text,
  status_code integer,
  latency_ms integer,
  request_id text,
  market_id text,
  trade_id text,
  idempotency_key text,
  event_time timestamptz not null default now(),
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  external_trade_id text not null,
  market_id text,
  side text check (side in ('buy_yes', 'buy_no')),
  size numeric(18, 8),
  entry_price numeric(18, 8),
  exit_price numeric(18, 8),
  fees_paid numeric(18, 8) not null default 0,
  status text not null default 'opened' check (status in ('opened', 'filled', 'closed', 'canceled')),
  opened_at timestamptz,
  filled_at timestamptz,
  closed_at timestamptz,
  realized_pnl numeric(18, 8),
  net_pnl numeric(18, 8),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (api_key_id, external_trade_id)
);

create table if not exists public.daily_metrics (
  day date primary key,
  dau integer not null default 0,
  unique_api_keys integer not null default 0,
  request_count integer not null default 0,
  signal_count integer not null default 0,
  executed_trades integer not null default 0,
  closed_trades integer not null default 0,
  gross_pnl numeric(18, 8) not null default 0,
  net_pnl numeric(18, 8) not null default 0,
  win_rate numeric(10, 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_analytics_events_event_time on public.analytics_events(event_time desc);
create index if not exists idx_analytics_events_event_type on public.analytics_events(event_type);
create index if not exists idx_analytics_events_api_key_id on public.analytics_events(api_key_id);
create index if not exists idx_analytics_events_endpoint on public.analytics_events(endpoint);
create index if not exists idx_trades_api_key_id on public.trades(api_key_id);
create index if not exists idx_trades_status on public.trades(status);
create index if not exists idx_trades_closed_at on public.trades(closed_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_api_keys_updated_at on public.api_keys;
create trigger trg_api_keys_updated_at
before update on public.api_keys
for each row execute function public.set_updated_at();

drop trigger if exists trg_trades_updated_at on public.trades;
create trigger trg_trades_updated_at
before update on public.trades
for each row execute function public.set_updated_at();

drop trigger if exists trg_daily_metrics_updated_at on public.daily_metrics;
create trigger trg_daily_metrics_updated_at
before update on public.daily_metrics
for each row execute function public.set_updated_at();
