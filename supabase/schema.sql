-- Supabase schema for Trading Bot
-- Run in Supabase SQL Editor

-- Enable UUID
create extension if not exists "pgcrypto";

-- signals table
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  pair text not null default 'BTCUSDT',
  timeframe text not null default '1h',
  direction text not null check (direction in ('LONG','SHORT','NO_TRADE')),
  entry numeric,
  sl numeric,
  tp numeric,
  confidence int check (confidence >=0 and confidence <=100),
  reasoning text,
  llm_model text,
  status text not null default 'closed' check (status in ('active','closed','pending','suppressed')),
  raw_prompt text,
  raw_response jsonb
);
create index if not exists idx_signals_created on signals(created_at desc);
create index if not exists idx_signals_status on signals(status);

-- outcomes table
create table if not exists outcomes (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references signals(id) on delete cascade,
  result text not null check (result in ('WIN','LOSS','BE')),
  exit_price numeric,
  pnl_pips numeric,
  hit text check (hit in ('SL','TP','TIMEOUT')),
  evaluated_at timestamptz default now()
);
create index if not exists idx_outcomes_signal on outcomes(signal_id);

-- ai_reflections table
create table if not exists ai_reflections (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  summary text,
  lesson text,
  winrate_week numeric,
  created_at timestamptz default now()
);

-- RLS enable (allow service_role full access, anon read if you want public dashboard behind basic auth)
alter table signals enable row level security;
alter table outcomes enable row level security;
alter table ai_reflections enable row level security;

-- Policies: allow service_role all, anon can read (since app protects via Basic Auth at API layer)
-- For POC easiest: allow all for authenticated and anon
create policy "allow all signals" on signals for all using (true) with check (true);
create policy "allow all outcomes" on outcomes for all using (true) with check (true);
create policy "allow all reflections" on ai_reflections for all using (true) with check (true);

-- Optional: pg_cron fallback (if you prefer Supabase cron instead of GitHub Actions)
-- Requires pg_cron and pg_net extensions (enable in Supabase dashboard)
-- Example (uncomment if needed):
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule('analyze-1h', '0 * * * *', $$ select net.http_post(url:='https://your-app.vercel.app/api/cron/analyze', headers:='{"x-cron-secret":"YOUR_CRON_SECRET","Content-Type":"application/json"}'::jsonb) $$);

-- MIGRATION (run if signals table already exists): allow 'suppressed' status for duplicate-filtered signals
alter table signals drop constraint if exists signals_status_check;
alter table signals add constraint signals_status_check check (status in ('active','closed','pending','suppressed'));
