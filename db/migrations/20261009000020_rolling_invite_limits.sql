-- migrate:up
-- Invite limits without resets (Jibran, 09.10.2026):
--  1. The weekly cap counts the LAST 7 DAYS (rolling), like LinkedIn, instead of the calendar week.
--     Before, the count dropped to 0 every Monday 00:00, so 100 on Sunday + 100 on Monday was allowed.
--     invites_resume_at = when the oldest invite in the window drops out.
--  2. Pending invites: the last LinkedIn count is never silently replaced by the (much lower) database
--     count. If the LinkedIn count is older than 2 days, invites wait ('pending_unknown') until a sync
--     reads the real number again. Before, after 2 days 328 pending turned into 51 and invites reopened.
-- Output keys stay the same (week_started = start of the 7-day window, next_week = resume time).

create or replace function outreach.limits()
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  tz text := 'Europe/Berlin';
  window_start timestamptz := now() - interval '7 days';
  day_start timestamptz := date_trunc('day', now() at time zone tz) at time zone tz;
  s jsonb := (select jsonb_object_agg(key, value) from outreach.settings);
  d_cap int := coalesce(nullif(s->>'daily_invite_cap','')::int, 20);
  w_cap int := coalesce(nullif(s->>'weekly_invite_cap','')::int, 100);
  m_cap int := coalesce(nullif(s->>'daily_message_cap','')::int, 40);
  p_cap int := coalesce(nullif(s->>'pending_invite_cap','')::int, 300);
  alert timestamptz := nullif(s->>'linkedin_limit_alert','')::timestamptz;
  alert_until timestamptz;
  manual timestamptz := nullif(s->>'invites_paused_until','')::timestamptz;
  li_pending int := nullif(s->>'linkedin_pending_invites','')::int;
  li_checked timestamptz := nullif(trim(both '"' from s->>'linkedin_pending_checked_at'),'')::timestamptz;
  li_fresh boolean;
  inv_today int; inv_week int; msg_today int; db_pending int; pending int;
  week_free_at timestamptz;
  until timestamptz; reason text := 'open';
begin
  if alert is not null then
    alert_until := greatest(alert + interval '7 days', (date_trunc('week', alert at time zone tz) + interval '7 days') at time zone tz);
  end if;
  select count(*) filter (where occurred_at >= day_start), count(*) into inv_today, inv_week
    from outreach.events where event_type = 'invite_sent' and ok and occurred_at >= window_start;
  -- when enough invites have left the window to be under the cap again
  select occurred_at + interval '7 days' into week_free_at
    from outreach.events where event_type = 'invite_sent' and ok and occurred_at >= window_start
    order by occurred_at offset greatest(inv_week - w_cap, 0) limit 1;
  select count(*) into msg_today from outreach.events where event_type = 'message_sent' and ok and occurred_at >= day_start;
  select count(*) into db_pending from outreach.prospects where stage = 'invited';
  li_fresh := li_checked is not null and li_checked > now() - interval '2 days';
  pending := greatest(db_pending, coalesce(li_pending, 0));

  if coalesce(s->>'paused','false') = 'true' then reason := 'robot_paused';
  elsif alert_until is not null and alert_until > now() then until := greatest(alert_until, coalesce(manual, alert_until)); reason := 'linkedin_warning';
  elsif manual is not null and manual > now() then until := manual; reason := 'paused_until';
  elsif inv_week >= w_cap then until := week_free_at; reason := 'weekly_cap';
  elsif pending >= p_cap then reason := 'pending_cap';
  elsif li_pending is not null and not li_fresh then reason := 'pending_unknown';
  elsif inv_today >= d_cap then until := day_start + interval '1 day'; reason := 'daily_cap';
  end if;

  return jsonb_build_object(
    'invite_status', reason, 'invites_resume_at', until,
    'invites_allowed_now', case when reason = 'open' then greatest(0, least(d_cap - inv_today, w_cap - inv_week)) else 0 end,
    'invites_today', inv_today, 'daily_invite_cap', d_cap,
    'invites_this_week', inv_week, 'weekly_invite_cap', w_cap, 'week_started', window_start,
    'next_week', coalesce(week_free_at, now()), 'week_is_rolling', true,
    'messages_today', msg_today, 'daily_message_cap', m_cap,
    'messages_allowed_now', case when coalesce(s->>'paused','false') = 'true' then 0 else greatest(0, m_cap - msg_today) end,
    'pending_invites', pending, 'pending_invites_db', db_pending, 'pending_invites_linkedin', li_pending,
    'pending_checked_at', li_checked, 'pending_invite_cap', p_cap);
end $function$;

-- migrate:down
-- (previous definition in 20261008000000_outreach_baseline.sql)
