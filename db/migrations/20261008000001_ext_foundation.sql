-- migrate:up
-- Phase 0: foundation for the self-hosted extension backend.
-- Additive only, on top of the outreach baseline. Settings defaults live in db/seed/ext_settings.sql
-- (re-applied on every start, insert-if-missing), so a data import from Supabase cannot clash with them.

-- Role used by the API. Login and password are set by deploy/scripts/init-roles.sh, not here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'api_rpc') then
    create role api_rpc nologin;
  end if;
end $$;

grant usage on schema public to api_rpc;

create table if not exists outreach.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists outreach.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references outreach.app_users(id) on delete cascade,
  device_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_user_idx on outreach.refresh_tokens(user_id);

create table if not exists outreach.ext_devices (
  device_id uuid primary key,
  user_id uuid not null references outreach.app_users(id) on delete cascade,
  name text,
  version text,
  user_agent text,
  last_error text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Never stores the model input (profile text is personal data). output is nulled after 30 days (Phase 6 job).
create table if not exists outreach.ai_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references outreach.app_users(id),
  task text not null,
  prompt_version int,
  model text,
  run_id bigint,
  prospect_id bigint,
  prompt_tokens int,
  completion_tokens int,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms int,
  ok boolean not null,
  error text,
  output jsonb
);
create index if not exists ai_calls_created_idx on outreach.ai_calls(created_at);

-- No direct table access for the API role; RLS on as a second guard.
alter table outreach.app_users enable row level security;
alter table outreach.refresh_tokens enable row level security;
alter table outreach.ext_devices enable row level security;
alter table outreach.ai_calls enable row level security;

-- Reads a setting as jsonb whether the column holds jsonb or text (plain text becomes a JSON string).
create or replace function outreach.ext_setting(p_key text)
returns jsonb
language plpgsql stable
set search_path = outreach, public
as $$
declare
  v text;
begin
  select value::text into v from outreach.settings where key = p_key;
  if v is null then
    return null;
  end if;
  begin
    return v::jsonb;
  exception when others then
    return to_jsonb(v);
  end;
end $$;

create or replace function outreach.ext_assert_user(p_user_id uuid)
returns void
language plpgsql stable
set search_path = outreach, public
as $$
begin
  if not exists (select 1 from outreach.app_users where id = p_user_id and enabled) then
    raise exception 'user not allowed' using errcode = '42501';
  end if;
end $$;

-- Auth helpers. The API hashes tokens; the database never sees a raw refresh token.
create or replace function public.ext_auth_get_user(p_email text)
returns jsonb
language sql stable security definer
set search_path = outreach, public
as $$
  select jsonb_build_object('id', id, 'password_hash', password_hash, 'enabled', enabled)
  from outreach.app_users where lower(email) = lower(p_email)
$$;

create or replace function public.ext_auth_user_enabled(p_user_id uuid)
returns jsonb
language sql stable security definer
set search_path = outreach, public
as $$
  select to_jsonb(coalesce((select enabled from outreach.app_users where id = p_user_id), false))
$$;

create or replace function public.ext_auth_store_refresh(
  p_user_id uuid, p_device_id uuid, p_token_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  v_id uuid;
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.refresh_tokens (user_id, device_id, token_hash, expires_at)
  values (p_user_id, p_device_id, p_token_hash, p_expires_at)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Rotates a refresh token. Reusing an already-rotated token revokes every token of that user.
create or replace function public.ext_auth_rotate_refresh(
  p_old_hash text, p_new_hash text, p_expires_at timestamptz)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  t outreach.refresh_tokens%rowtype;
  v_new uuid;
begin
  select * into t from outreach.refresh_tokens where token_hash = p_old_hash for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if t.revoked_at is not null then
    update outreach.refresh_tokens set revoked_at = now()
      where user_id = t.user_id and revoked_at is null;
    return jsonb_build_object('ok', false, 'reason', 'reused');
  end if;
  if t.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if not exists (select 1 from outreach.app_users where id = t.user_id and enabled) then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  insert into outreach.refresh_tokens (user_id, device_id, token_hash, expires_at)
  values (t.user_id, t.device_id, p_new_hash, p_expires_at)
  returning id into v_new;
  update outreach.refresh_tokens set revoked_at = now(), replaced_by = v_new where id = t.id;
  return jsonb_build_object('ok', true, 'user_id', t.user_id, 'device_id', t.device_id);
end $$;

create or replace function public.ext_auth_revoke_refresh(p_token_hash text)
returns jsonb
language sql security definer
set search_path = outreach, public
as $$
  with r as (
    update outreach.refresh_tokens set revoked_at = now()
    where token_hash = p_token_hash and revoked_at is null
    returning 1
  )
  select jsonb_build_object('revoked', (select count(*) from r))
$$;

create or replace function public.ext_heartbeat(
  p_user_id uuid, p_device_id uuid, p_name text, p_version text, p_user_agent text, p_last_error text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.ext_devices (device_id, user_id, name, version, user_agent, last_error, last_seen)
  values (p_device_id, p_user_id, p_name, p_version, p_user_agent, p_last_error, now())
  on conflict (device_id) do update set
    user_id = excluded.user_id,
    name = excluded.name,
    version = excluded.version,
    user_agent = excluded.user_agent,
    last_error = excluded.last_error,
    last_seen = now();
  return jsonb_build_object('ok', true, 'serverTime', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

-- Only the keys the extension may read.
create or replace function public.ext_get_settings(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'paused', coalesce(outreach.ext_setting('paused') in ('true'::jsonb, '"true"'::jsonb), false),
    'ext_enabled_actions', coalesce(outreach.ext_setting('ext_enabled_actions'), '[]'::jsonb),
    'ext_dry_run', coalesce(outreach.ext_setting('ext_dry_run') <> 'false'::jsonb, true),
    'ext_min_version', coalesce(outreach.ext_setting('ext_min_version') #>> '{}', '0.0.0'),
    'run_caps', outreach.ext_setting('run_caps'),
    'pacing', coalesce(outreach.ext_setting('pacing'), '{}'::jsonb),
    'run_schedule', outreach.ext_setting('run_schedule'),
    'robot_schedule', outreach.ext_setting('robot_schedule')
  );
end $$;

create or replace function public.ext_get_doc(p_user_id uuid, p_key text)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_key not in ('browsing_conduct', 'targeting_rules', 'target_groups', 'banned_phrases',
                   'voice_rules', 'trigger_rules', 'reply_rules') then
    raise exception 'doc not allowed: %', p_key using errcode = '42501';
  end if;
  return jsonb_build_object('key', p_key, 'body', coalesce(outreach.doc(p_key)::text, ''));
end $$;

-- Wraps outreach.limits(); works whether it returns jsonb, a composite or a one-row table.
create or replace function public.ext_limits(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  v jsonb;
begin
  perform outreach.ext_assert_user(p_user_id);
  select to_jsonb(l) into v from outreach.limits() l limit 1;
  return v;
end $$;

-- Remaining AI budget for today (Europe/Berlin) in USD.
create or replace function public.ext_ai_budget_left(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  v_budget numeric := coalesce((outreach.ext_setting('ai_daily_budget_usd') #>> '{}')::numeric, 0);
  v_spent numeric;
begin
  perform outreach.ext_assert_user(p_user_id);
  select coalesce(sum(cost_usd), 0) into v_spent from outreach.ai_calls
  where created_at >= (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin');
  return jsonb_build_object('budget', v_budget, 'spent', v_spent, 'left', v_budget - v_spent);
end $$;

create or replace function public.ext_log_ai_call(
  p_user_id uuid, p_task text, p_prompt_version int, p_model text, p_run_id bigint, p_prospect_id bigint,
  p_prompt_tokens int, p_completion_tokens int, p_cost_usd numeric, p_latency_ms int,
  p_ok boolean, p_error text, p_output jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  v_id uuid;
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.ai_calls (user_id, task, prompt_version, model, run_id, prospect_id,
    prompt_tokens, completion_tokens, cost_usd, latency_ms, ok, error, output)
  values (p_user_id, p_task, p_prompt_version, p_model, p_run_id, p_prospect_id,
    p_prompt_tokens, p_completion_tokens, coalesce(p_cost_usd, 0), p_latency_ms, p_ok, left(p_error, 2000), p_output)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Grants: the API role may execute these functions and nothing else.
do $$
declare
  f text;
begin
  foreach f in array array[
    'ext_auth_get_user(text)',
    'ext_auth_user_enabled(uuid)',
    'ext_auth_store_refresh(uuid,uuid,text,timestamptz)',
    'ext_auth_rotate_refresh(text,text,timestamptz)',
    'ext_auth_revoke_refresh(text)',
    'ext_heartbeat(uuid,uuid,text,text,text,text)',
    'ext_get_settings(uuid)',
    'ext_get_doc(uuid,text)',
    'ext_limits(uuid)',
    'ext_ai_budget_left(uuid)',
    'ext_log_ai_call(uuid,text,int,text,bigint,bigint,int,int,numeric,int,boolean,text,jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_log_ai_call(uuid,text,int,text,bigint,bigint,int,int,numeric,int,boolean,text,jsonb);
drop function if exists public.ext_ai_budget_left(uuid);
drop function if exists public.ext_limits(uuid);
drop function if exists public.ext_get_doc(uuid,text);
drop function if exists public.ext_get_settings(uuid);
drop function if exists public.ext_heartbeat(uuid,uuid,text,text,text,text);
drop function if exists public.ext_auth_revoke_refresh(text);
drop function if exists public.ext_auth_rotate_refresh(text,text,timestamptz);
drop function if exists public.ext_auth_store_refresh(uuid,uuid,text,timestamptz);
drop function if exists public.ext_auth_user_enabled(uuid);
drop function if exists public.ext_auth_get_user(text);
drop function if exists outreach.ext_assert_user(uuid);
drop function if exists outreach.ext_setting(text);
drop table if exists outreach.ai_calls;
drop table if exists outreach.ext_devices;
drop table if exists outreach.refresh_tokens;
drop table if exists outreach.app_users;
