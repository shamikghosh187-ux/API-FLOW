-- API FLOW BYOK control-plane schema foundation.
-- Apply after 202610290001_api_flow_saas_foundation.sql.
-- Secrets are ciphertext only. Encryption/decryption must be performed by a trusted
-- backend using KMS/Vault-backed envelope encryption; clients must never write ciphertext directly.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','developer','viewer','billing')),
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index if not exists organization_members_user_idx on public.organization_members(user_id, organization_id);

create table if not exists public.provider_registry (
  id text primary key,
  display_name text not null,
  adapter_id text not null,
  enabled boolean not null default true,
  capabilities jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  provider_id text not null references public.provider_registry(id),
  label text not null check (char_length(label) between 1 and 80),
  secret_ciphertext bytea not null,
  secret_nonce bytea not null,
  secret_auth_tag bytea not null,
  wrapped_data_key bytea not null,
  encryption_key_version text not null,
  masked_suffix text not null default '',
  status text not null default 'active' check (status in ('active','disabled','invalid','cooldown','revoked')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((owner_user_id is not null)::int + (organization_id is not null)::int = 1)
);
create index if not exists provider_credentials_user_idx on public.provider_credentials(owner_user_id, provider_id, status) where revoked_at is null;
create index if not exists provider_credentials_org_idx on public.provider_credentials(organization_id, provider_id, status) where revoked_at is null;

create table if not exists public.key_pools (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  pool_type text not null default 'personal' check (pool_type in ('personal','team','shared','custom')),
  strategy text not null default 'custom_priority' check (strategy in ('free_only','lowest_cost','lowest_latency','quality','availability','custom_priority')),
  policy jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_user_id is not null)::int + (organization_id is not null)::int = 1)
);
create index if not exists key_pools_user_idx on public.key_pools(owner_user_id, created_at desc);
create index if not exists key_pools_org_idx on public.key_pools(organization_id, created_at desc);

create table if not exists public.key_pool_members (
  pool_id uuid not null references public.key_pools(id) on delete cascade,
  credential_id uuid not null references public.provider_credentials(id) on delete cascade,
  priority integer not null default 100 check (priority >= 0),
  weight integer not null default 1 check (weight between 1 and 1000),
  enabled boolean not null default true,
  added_at timestamptz not null default now(),
  primary key (pool_id, credential_id)
);
create index if not exists key_pool_members_order_idx on public.key_pool_members(pool_id, enabled, priority);

create table if not exists public.routing_policies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  active_version integer,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((owner_user_id is not null)::int + (organization_id is not null)::int = 1)
);

create table if not exists public.routing_policy_versions (
  policy_id uuid not null references public.routing_policies(id) on delete cascade,
  version integer not null check (version > 0),
  config jsonb not null,
  config_sha256 text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  primary key (policy_id, version)
);
alter table public.routing_policies drop constraint if exists routing_policies_active_version_fk;
alter table public.routing_policies add constraint routing_policies_active_version_fk
  foreign key (id, active_version) references public.routing_policy_versions(policy_id, version)
  deferrable initially deferred;

create table if not exists public.gateway_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default array['gateway:invoke']::text[],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((owner_user_id is not null)::int + (organization_id is not null)::int = 1)
);
create index if not exists gateway_tokens_user_idx on public.gateway_tokens(owner_user_id, created_at desc);
create index if not exists gateway_tokens_org_idx on public.gateway_tokens(organization_id, created_at desc);

create table if not exists public.gateway_requests (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  owner_user_id uuid references auth.users(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  requested_model text not null,
  selected_provider_id text references public.provider_registry(id) on delete set null,
  selected_model text,
  policy_id uuid references public.routing_policies(id) on delete set null,
  policy_version integer,
  region text,
  status text not null check (status in ('success','failed','cancelled','rejected')),
  duration_ms integer check (duration_ms >= 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  estimated_cost numeric(20,10) check (estimated_cost >= 0),
  cost_currency text not null default 'USD',
  cost_source text not null default 'unknown' check (cost_source in ('provider_reported','price_estimate','unknown')),
  created_at timestamptz not null default now()
);
create index if not exists gateway_requests_user_time_idx on public.gateway_requests(owner_user_id, created_at desc);
create index if not exists gateway_requests_org_time_idx on public.gateway_requests(organization_id, created_at desc);
create index if not exists gateway_requests_provider_time_idx on public.gateway_requests(selected_provider_id, created_at desc);

create table if not exists public.gateway_attempts (
  id uuid primary key default gen_random_uuid(),
  request_row_id uuid not null references public.gateway_requests(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  provider_id text references public.provider_registry(id) on delete set null,
  credential_id uuid references public.provider_credentials(id) on delete set null,
  model text,
  outcome text not null check (outcome in ('success','retryable_failure','terminal_failure','skipped','cancelled')),
  http_status integer,
  error_class text,
  duration_ms integer check (duration_ms >= 0),
  retry_decision text,
  created_at timestamptz not null default now(),
  unique (request_row_id, attempt_number)
);
create index if not exists gateway_attempts_request_idx on public.gateway_attempts(request_row_id, attempt_number);

create table if not exists public.credential_health (
  credential_id uuid primary key references public.provider_credentials(id) on delete cascade,
  health_category text not null default 'warning' check (health_category in ('excellent','good','warning','critical','dead')),
  success_rate numeric(6,5) check (success_rate between 0 and 1),
  latency_p50_ms integer,
  latency_p95_ms integer,
  sample_count bigint not null default 0 check (sample_count >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  cooldown_until timestamptz,
  circuit_state text not null default 'closed' check (circuit_state in ('closed','open','half_open')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_org_time_idx on public.audit_logs(organization_id, created_at desc);
create index if not exists audit_logs_actor_time_idx on public.audit_logs(actor_user_id, created_at desc);

-- RLS is enabled by default-deny on sensitive control-plane tables. Backend service
-- operations must use narrowly scoped server credentials and perform authorization
-- checks; browser clients do not receive permission to insert encrypted credentials.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.provider_credentials enable row level security;
alter table public.key_pools enable row level security;
alter table public.key_pool_members enable row level security;
alter table public.routing_policies enable row level security;
alter table public.routing_policy_versions enable row level security;
alter table public.gateway_tokens enable row level security;
alter table public.gateway_requests enable row level security;
alter table public.gateway_attempts enable row level security;
alter table public.credential_health enable row level security;
alter table public.audit_logs enable row level security;

-- Initial self-service read policies. Organization data access beyond membership
-- checks is intentionally server-mediated until role-specific policies are added.
drop policy if exists "users read own provider credentials" on public.provider_credentials;
create policy "users read own provider credentials" on public.provider_credentials
  for select to authenticated using (owner_user_id = auth.uid());

drop policy if exists "users read own key pools" on public.key_pools;
create policy "users read own key pools" on public.key_pools
  for select to authenticated using (owner_user_id = auth.uid());

drop policy if exists "users read own routing policies" on public.routing_policies;
create policy "users read own routing policies" on public.routing_policies
  for select to authenticated using (owner_user_id = auth.uid());

drop policy if exists "users read own gateway tokens metadata" on public.gateway_tokens;
create policy "users read own gateway tokens metadata" on public.gateway_tokens
  for select to authenticated using (owner_user_id = auth.uid());

-- The following global provider registry rows are metadata, not secrets.
insert into public.provider_registry (id, display_name, adapter_id, capabilities)
values
 ('openai','OpenAI','openai', '{"chat":true,"streaming":true}'::jsonb),
 ('anthropic','Anthropic','anthropic', '{"chat":true,"streaming":true,"vision":true}'::jsonb),
 ('gemini','Google Gemini','gemini', '{"chat":true,"streaming":true,"vision":true}'::jsonb),
 ('groq','Groq','groq', '{"chat":true,"streaming":true}'::jsonb),
 ('openrouter','OpenRouter','openrouter', '{"chat":true,"streaming":true}'::jsonb),
 ('together','Together AI','together', '{"chat":true,"streaming":true}'::jsonb),
 ('deepseek','DeepSeek','deepseek', '{"chat":true,"streaming":true}'::jsonb),
 ('mistral','Mistral','mistral', '{"chat":true,"streaming":true}'::jsonb),
 ('azure-openai','Azure OpenAI','azure-openai', '{"chat":true,"streaming":true}'::jsonb),
 ('ollama','Ollama','openai-compatible', '{"chat":true,"streaming":true,"local":true}'::jsonb),
 ('lm-studio','LM Studio','openai-compatible', '{"chat":true,"streaming":true,"local":true}'::jsonb),
 ('vllm','vLLM','openai-compatible', '{"chat":true,"streaming":true,"local":true}'::jsonb),
 ('custom-openai-compatible','Custom OpenAI-compatible','openai-compatible', '{"chat":true,"streaming":true}'::jsonb)
on conflict (id) do update set display_name = excluded.display_name, adapter_id = excluded.adapter_id, capabilities = excluded.capabilities, updated_at = now();
