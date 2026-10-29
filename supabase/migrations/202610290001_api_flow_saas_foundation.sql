-- API FLOW SaaS foundation
-- Apply this migration to a fresh Supabase project using the SQL Editor or Supabase CLI.
-- Customer API secrets are stored as hashes only; never store plaintext API keys.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  plan text not null default 'free' check (plan in ('free', 'pro', 'business')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_keys_user_id_created_at_idx
  on public.api_keys (user_id, created_at desc);
create index if not exists api_keys_active_prefix_idx
  on public.api_keys (key_prefix)
  where revoked_at is null;

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  api_key_id uuid references public.api_keys(id) on delete set null,
  provider text not null check (provider in ('groq', 'openrouter', 'other')),
  model text,
  status_code integer not null check (status_code between 100 and 599),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_created_at_idx
  on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_key_created_at_idx
  on public.usage_events (api_key_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.usage_events enable row level security;

-- Users may read only their own profile. Plan changes must be performed by
-- trusted server-side code, never by the browser.
drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

-- The initial browser policy deliberately allows listing key metadata only through
-- a future server API; direct table access is denied to authenticated clients too.
-- The gateway backend will use a server-only Supabase secret and enforce ownership.
drop policy if exists "No direct client access to API keys" on public.api_keys;
create policy "No direct client access to API keys"
  on public.api_keys for all to authenticated
  using (false)
  with check (false);

-- Usage records are private. The dashboard will read them through a server route
-- that verifies the authenticated user and scopes every query to that user.
drop policy if exists "No direct client access to usage events" on public.usage_events;
create policy "No direct client access to usage events"
  on public.usage_events for all to authenticated
  using (false)
  with check (false);

comment on table public.api_keys is
  'Store only a cryptographic hash of each customer API key. Display plaintext once at creation; never persist it.';
comment on table public.usage_events is
  'Request-level usage ledger. Avoid storing prompts, completions, provider secrets, or other sensitive payloads.';
