-- migrate:up
-- Voice profile fixes (10.10.2026, job #30: the answer was cut off at 6000 tokens three times):
--  1. prompt v2: 14000 output tokens and short fields;
--  2. the samples are kept when the AI step fails (status 'failed'), so "Try again" re-runs the AI on
--     them without reading LinkedIn again.

alter table outreach.voice_profiles drop constraint if exists voice_profiles_status_check;
alter table outreach.voice_profiles add constraint voice_profiles_status_check
  check (status in ('draft', 'approved', 'replaced', 'rejected', 'failed'));

create or replace function public.ext_voice_keep_failed(p_user_id uuid, p_samples jsonb, p_fingerprint jsonb, p_error text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare v_id bigint;
begin
  perform outreach.ext_assert_user(p_user_id);
  delete from outreach.voice_profiles where status = 'failed';
  insert into outreach.voice_profiles (status, samples, fingerprint, profile, better)
  values ('failed', p_samples, p_fingerprint, jsonb_build_object('error', left(p_error, 500)), '{}')
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.ext_voice_failed_samples(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select jsonb_build_object('id', id, 'samples', samples, 'error', profile->>'error', 'created_at', created_at)
          from outreach.voice_profiles where status = 'failed' order by id desc limit 1);
end $$;

-- the Voice tab also shows a failed attempt (so it can offer "Try again")
create or replace function public.ext_voice_get(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'draft', (select to_jsonb(v) - 'samples' || jsonb_build_object(
                'sample_counts', jsonb_build_object(
                  'posts', jsonb_array_length(coalesce(v.samples->'posts', '[]')),
                  'comments', jsonb_array_length(coalesce(v.samples->'comments', '[]'))))
              from outreach.voice_profiles v where status = 'draft' order by id desc limit 1),
    'approved', (select to_jsonb(v) - 'samples' from outreach.voice_profiles v
                 where status = 'approved' order by approved_at desc limit 1),
    'failed', (select jsonb_build_object('id', id, 'created_at', created_at, 'error', profile->>'error',
                 'posts', jsonb_array_length(coalesce(samples->'posts', '[]')),
                 'comments', jsonb_array_length(coalesce(samples->'comments', '[]')))
               from outreach.voice_profiles where status = 'failed' order by id desc limit 1));
end $$;

-- a successful analysis removes the failed attempt
create or replace function public.ext_voice_save(p_user_id uuid, p_samples jsonb, p_fingerprint jsonb,
  p_profile jsonb, p_better jsonb, p_ai_call_id bigint)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare v_id bigint;
begin
  perform outreach.ext_assert_user(p_user_id);
  update outreach.voice_profiles set status = 'replaced' where status = 'draft';
  delete from outreach.voice_profiles where status = 'failed';
  insert into outreach.voice_profiles (samples, fingerprint, profile, better, ai_call_id)
  values (p_samples, p_fingerprint, p_profile, p_better, p_ai_call_id) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 2, false, model, fallback_models,
       system_prompt || $add$

Keep it short: every text field at most 2 sentences; lists at most 6 items, each under 20 words; quotes under 30 words.$add$,
       user_template, json_schema, temperature, 14000, 'v2: short fields, 14000 tokens (v1 was cut off at 6000)'
from outreach.ai_prompts where task = 'voice_profile' and version = 1
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = (version = 2) where task = 'voice_profile';

do $$
declare f text;
begin
  foreach f in array array['ext_voice_keep_failed(uuid,jsonb,jsonb,text)', 'ext_voice_failed_samples(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
update outreach.ai_prompts set active = (version = 1) where task = 'voice_profile';
delete from outreach.ai_prompts where task = 'voice_profile' and version = 2;
drop function if exists public.ext_voice_failed_samples(uuid);
drop function if exists public.ext_voice_keep_failed(uuid,jsonb,jsonb,text);
