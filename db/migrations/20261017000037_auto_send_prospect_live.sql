-- migrate:up
-- Jibran, 17.10.2026:
-- 1. "Go live" switch in the app: ext_set_live() flips settings.ext_dry_run. It stays out of the
--    generic ext_setting_set() so it can only be changed through its own confirmed route.
-- 2. Automatic prospecting and automatic sending (settings prospect_auto, send_auto; both off by
--    default). The extension starts the jobs; every check stays in ext_send_batch().
-- 3. Invites spread over the week: a live batch hands out at most today's target, which is the weekly
--    cap divided by the send days in robot_schedule, varied by +-20 % per day, never above the daily cap.

insert into outreach.settings (key, value, note) values
  ('prospect_auto', 'false', 'Find prospects automatically: one round on weekday mornings (08-10, Berlin)'),
  ('send_auto', 'false', 'Send approved items automatically in small batches inside the send times (live only)')
on conflict (key) do nothing;

create or replace function outreach.invite_day_target(p_at timestamptz default now())
returns int
language plpgsql stable
set search_path = outreach, public
as $$
declare
  lim jsonb := outreach.limits();
  d_cap int := coalesce((lim->>'daily_invite_cap')::int, 0);
  w_cap int := coalesce((lim->>'weekly_invite_cap')::int, 0);
  s jsonb := outreach.ext_setting('robot_schedule');
  days int;
  base numeric;
  f numeric;
begin
  if s is null then days := 7;
  else
    select count(*) into days from generate_series(0, 6) d
     where jsonb_array_length(coalesce(s -> d::text, '[]'::jsonb)) > 0;
  end if;
  if days = 0 or d_cap = 0 or w_cap = 0 then return 0; end if;
  base := least(d_cap, ceil(w_cap::numeric / days));
  -- Same factor all day, different per day: 0.8 .. 1.2 from the Berlin date.
  f := 0.8 + 0.4 * (('x' || substr(md5(to_char(p_at at time zone 'Europe/Berlin', 'YYYY-MM-DD')), 1, 6))::bit(24)::int / 16777215.0);
  return least(d_cap, greatest(1, round(base * f)))::int;
end $$;

create or replace function public.ext_send_batch(p_user_id uuid, p_max int)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  lim jsonb := outreach.limits();
  paused boolean := coalesce(outreach.ext_setting('paused') in ('true'::jsonb, '"true"'::jsonb), false);
  practice boolean := coalesce(outreach.ext_setting('ext_dry_run') <> 'false'::jsonb, true);
  msg_left int := coalesce((lim->>'messages_allowed_now')::int, 0);
  inv_left int := coalesce((lim->>'invites_allowed_now')::int, 0);
  target int := outreach.invite_day_target();
  items jsonb;
  stale int;
begin
  perform outreach.ext_assert_user(p_user_id);
  if practice then
    -- Practice sends nothing, so up to 3 of each may be practised even when the limits are reached.
    msg_left := greatest(msg_left, 3);
    inv_left := greatest(inv_left, 3);
  else
    inv_left := least(inv_left, greatest(0, target - coalesce((lim->>'invites_today')::int, 0)));
  end if;
  select count(*) into stale from outreach.action_queue
   where status = 'approved' and due_at < now() - interval '14 days';
  if paused or not outreach.send_window_open() then
    return jsonb_build_object('items', '[]'::jsonb, 'practice', practice, 'paused', paused,
      'window_open', outreach.send_window_open(), 'stale', stale, 'limits', lim, 'invite_day_target', target);
  end if;
  with base as (
    select q.id, q.action, q.message_text, q.due_at, q.campaign_id, q.step,
           p.id as prospect_id, p.full_name, p.first_name, p.linkedin_url, p.stage,
           case q.action when 'reply' then 1 when 'message' then 2 when 'inmail' then 2 when 'withdraw' then 3 when 'connect' then 4 else 9 end as prio
    from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
    where q.status = 'approved' and q.due_at <= now() and q.due_at >= now() - interval '14 days'
      and q.action in ('reply', 'message', 'withdraw', 'connect')
      and p.stage not in ('blacklisted', 'skipped', 'withdrawn', 'completed')
      and not (q.action in ('message', 'connect', 'withdraw') and p.stage = 'replied')
  ), ranked as (
    select b.*, row_number() over (partition by case when action in ('reply', 'message') then 'msg' else action end order by due_at) as n
    from base b
  )
  select coalesce(jsonb_agg(to_jsonb(r) - 'n' - 'prio' order by r.prio, r.due_at), '[]') into items
  from (select * from ranked
        where (action in ('reply', 'message') and n <= msg_left)
           or (action = 'connect' and n <= inv_left)
           or (action = 'withdraw' and n <= 20)
        order by prio, due_at limit greatest(1, least(coalesce(p_max, 5), 10))) r;
  return jsonb_build_object('items', items, 'practice', practice, 'paused', paused, 'window_open', true,
                            'stale', stale, 'limits', lim, 'invite_day_target', target);
end $$;

-- Live switch. Returns the new state; the API asks for an explicit confirmation before calling it.
create or replace function public.ext_set_live(p_user_id uuid, p_live boolean)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.settings (key, value, note)
  values ('ext_dry_run', case when p_live then 'false' else 'true' end,
          case when p_live then 'LIVE: switched on in the app' else 'dry run: switched on in the app' end)
  on conflict (key) do update set value = excluded.value, note = excluded.note, updated_at = now();
  return jsonb_build_object('live', p_live, 'invite_day_target', outreach.invite_day_target());
end $$;

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
                        'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused',
                        'sync_auto', 'prospect_auto', 'send_auto', 'ext_dry_run'))
         || jsonb_build_object('invite_day_target', jsonb_build_object('value', outreach.invite_day_target()));
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
                   'comment_round_times', 'comment_autopost_daily_max', 'ai_daily_budget_usd', 'paused',
                   'sync_auto', 'prospect_auto', 'send_auto') then
    raise exception 'setting % cannot be changed here', p_key using errcode = '22023';
  end if;
  insert into outreach.settings (key, value, note)
  values (p_key, case when jsonb_typeof(p_value) = 'string' then p_value #>> '{}' else p_value::text end, 'set in the app')
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

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
    'sync_auto', coalesce(outreach.ext_setting('sync_auto') = 'true'::jsonb, false),
    'prospect_auto', coalesce(outreach.ext_setting('prospect_auto') = 'true'::jsonb, false),
    'send_auto', coalesce(outreach.ext_setting('send_auto') = 'true'::jsonb, false)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_set_live(uuid,boolean)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_set_live(uuid,boolean);
drop function if exists outreach.invite_day_target(timestamptz);
