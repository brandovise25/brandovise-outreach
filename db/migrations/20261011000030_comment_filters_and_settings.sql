-- migrate:up
-- 1. Comments tab filters (Jibran, 11.10.2026): to review / approved / posted / rejected, with counts;
--    posted comments stay visible (before: only the last 3 days).
-- 2. Settings tab: Jibran edits send times, caps and robot hours in the app. Only the keys listed here
--    can be changed this way; values are validated in the API before they reach this function.

create or replace function public.ext_list_comments_filtered(p_user_id uuid, p_filter text)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare v_status text[];
begin
  perform outreach.ext_assert_user(p_user_id);
  v_status := case p_filter
    when 'review' then array['drafted']
    when 'approved' then array['approved', 'check']
    when 'posted' then array['posted']
    when 'rejected' then array['rejected']
    else array['drafted', 'approved', 'check'] end;
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'review', count(*) filter (where status = 'drafted'),
        'approved', count(*) filter (where status in ('approved', 'check')),
        'posted', count(*) filter (where status = 'posted'),
        'rejected', count(*) filter (where status = 'rejected'))
      from outreach.engagement),
    'items', (select coalesce(jsonb_agg(to_jsonb(e) order by e.sort_at desc), '[]') from (
      select id, created_at, post_url, post_excerpt, post_age, author_name, author_headline, author_profile,
             comment_draft, reason, status, reviewed_at, verified, posted_url, posted_at,
             post_log->-1 as last_attempt, coalesce(posted_at, reviewed_at, created_at) as sort_at
      from outreach.engagement
      where status = any(v_status)
      order by coalesce(posted_at, reviewed_at, created_at) desc limit 200) e));
end $$;

-- Editable settings, with their notes, for the Settings tab.
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
                        'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused'));
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
                   'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused') then
    raise exception 'setting % cannot be changed here', p_key using errcode = '22023';
  end if;
  insert into outreach.settings (key, value, note)
  values (p_key, case when jsonb_typeof(p_value) = 'string' then p_value #>> '{}' else p_value::text end, 'set in the app')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

insert into outreach.settings (key, value, note)
values ('comment_round_times', '["11:20", "16:40"]', 'Times (Berlin) of the automatic comment rounds')
on conflict (key) do nothing;

-- The extension also gets the round times.
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
    'comment_round_times', outreach.ext_setting('comment_round_times')
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_list_comments_filtered(uuid,text)', 'ext_settings_for_edit(uuid)', 'ext_setting_set(uuid,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_setting_set(uuid,text,jsonb);
drop function if exists public.ext_settings_for_edit(uuid);
drop function if exists public.ext_list_comments_filtered(uuid,text);
