-- migrate:up
-- Sync round (read-only on LinkedIn): what the robot read on the connections, sent-invitations and
-- inbox pages updates the prospects. Only stages change; the existing triggers do the rest (accepted ->
-- message 1 is scheduled; replied -> pending actions are cancelled). Matching happens in the API.

alter table outreach.ext_jobs drop constraint if exists ext_jobs_kind_check;
alter table outreach.ext_jobs add constraint ext_jobs_kind_check check (kind in (
  'comment_round', 'post_comment', 'capture_sync', 'prospect_round', 'import_leads', 'sync_round',
  'send_round', 'voice_profile'));

alter table outreach.events drop constraint if exists events_event_type_check;
alter table outreach.events add constraint events_event_type_check check (event_type = any (array[
  'found', 'visit', 'invite_sent', 'invite_withdrawn', 'accepted', 'message_sent', 'reply_detected',
  'skipped', 'error', 'stage_change', 'imported', 'limit_warning', 'sync']));

-- Active prospects the sync can match against.
create or replace function public.ext_sync_targets(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'name', coalesce(full_name, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))),
            'url', outreach.norm_li_url(linkedin_url), 'stage', stage, 'invited_at', invited_at,
            'accepted_at', accepted_at, 'last_out', greatest(msg1_at, msg2_at, msg3_at, accepted_at, invited_at))), '[]')
          from outreach.prospects
          where stage in ('invited', 'accepted', 'msg1_sent', 'msg2_sent', 'msg3_sent'));
end $$;

-- Applies matched results. p_accepted: [{id, at}], p_replied: [{id, snippet}].
create or replace function public.ext_sync_apply(p_user_id uuid, p_accepted jsonb, p_replied jsonb, p_pending int, p_job_id bigint)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare n_acc int := 0; n_rep int := 0; r jsonb;
begin
  perform outreach.ext_assert_user(p_user_id);
  for r in select * from jsonb_array_elements(coalesce(p_accepted, '[]')) loop
    update outreach.prospects set stage = 'accepted',
           accepted_at = coalesce((r->>'at')::timestamptz, now()), last_checked_at = now()
     where id = (r->>'id')::bigint and stage = 'invited';
    if found then
      n_acc := n_acc + 1;
      insert into outreach.events (event_type, ok, prospect_id, detail)
      values ('accepted', true, (r->>'id')::bigint, jsonb_build_object('source', 'extension-sync', 'job', p_job_id));
    end if;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_replied, '[]')) loop
    update outreach.prospects set stage = 'replied', replied_at = now(),
           reply_snippet = left(r->>'snippet', 500), last_checked_at = now()
     where id = (r->>'id')::bigint and stage in ('invited', 'accepted', 'msg1_sent', 'msg2_sent', 'msg3_sent');
    if found then
      n_rep := n_rep + 1;
      insert into outreach.events (event_type, ok, prospect_id, detail)
      values ('reply_detected', true, (r->>'id')::bigint, jsonb_build_object('source', 'extension-sync', 'snippet', left(r->>'snippet', 300), 'job', p_job_id));
    end if;
  end loop;
  if p_pending is not null then
    insert into outreach.settings (key, value, note) values ('linkedin_pending_invites', p_pending::text, 'read by the sync round')
    on conflict (key) do update set value = excluded.value, updated_at = now();
    insert into outreach.settings (key, value, note) values ('linkedin_pending_checked_at', to_jsonb(now())::text, 'read by the sync round')
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  insert into outreach.events (event_type, ok, detail)
  values ('sync', true, jsonb_build_object('accepted', n_acc, 'replied', n_rep, 'pending', p_pending, 'job', p_job_id));
  perform outreach.robot_tick();
  return jsonb_build_object('accepted', n_acc, 'replied', n_rep, 'pending', p_pending);
end $$;

-- Settings: automatic sync on/off.
insert into outreach.settings (key, value, note)
values ('sync_auto', 'false', 'Sync LinkedIn (accepted, replies, pending) automatically every 25-40 minutes in robot hours')
on conflict (key) do nothing;

create or replace function public.ext_settings_for_edit(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_object_agg(key, jsonb_build_object('value', outreach.ext_setting(key), 'note', note, 'updated_at', updated_at)), '{}')
          from outreach.settings
          where key in ('robot_schedule', 'daily_invite_cap', 'weekly_invite_cap', 'daily_message_cap',
                        'pending_invite_cap', 'withdraw_after_days', 'job_hours', 'job_gap_seconds',
                        'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused', 'sync_auto'));
end $$;

create or replace function public.ext_setting_set(p_user_id uuid, p_key text, p_value jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_key not in ('robot_schedule', 'daily_invite_cap', 'weekly_invite_cap', 'daily_message_cap',
                   'pending_invite_cap', 'withdraw_after_days', 'job_hours', 'job_gap_seconds',
                   'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused', 'sync_auto') then
    raise exception 'setting % cannot be changed here', p_key using errcode = '22023';
  end if;
  insert into outreach.settings (key, value, note)
  values (p_key, case when jsonb_typeof(p_value) = 'string' then p_value #>> '{}' else p_value::text end, 'set in the app')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;


-- The extension also learns whether to sync automatically.
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
    'robot_schedule', outreach.ext_setting('robot_schedule'),
    'comment_round_times', outreach.ext_setting('comment_round_times'),
    'sync_auto', coalesce(outreach.ext_setting('sync_auto') = 'true'::jsonb, false)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_sync_targets(uuid)', 'ext_sync_apply(uuid,jsonb,jsonb,int,bigint)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_sync_apply(uuid,jsonb,jsonb,int,bigint);
drop function if exists public.ext_sync_targets(uuid);
