-- Run this once in the Supabase SQL editor (project: vzwrvaadlttfrldimapa).
-- Adds fields for auto-granted free months from the /404 gift form.

alter table public.subscriptions
  add column if not exists pro_until     timestamptz,
  add column if not exists grant_source  text;

-- Optional: index for the expiry cron.
create index if not exists subscriptions_pro_until_idx
  on public.subscriptions (pro_until)
  where pro_until is not null;

-- Claims log (1 row per 404-gift submission, for analytics + anti-abuse).
create table if not exists public.freemonth_claims (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  email         text not null,
  name          text,
  use_case      text,
  source        text,
  source_detail text,
  path          text,
  referrer      text,
  user_agent    text,
  months_granted int not null default 1,
  created_at    timestamptz not null default now()
);

create index if not exists freemonth_claims_email_idx
  on public.freemonth_claims (email);

alter table public.freemonth_claims enable row level security;

create policy "Service role full access on freemonth_claims"
  on public.freemonth_claims for all
  using (auth.role() = 'service_role');
