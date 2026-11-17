-- migrate:up
-- Prospecting paused for days (17.11.2026): the robot skips a prospect round while 40 or more leads and
-- drafts wait for review, and 36 suggested withdrawals of old invites counted as drafts. Withdrawals are
-- housekeeping, not new contacts, so the dashboard also gives the count without them
-- (counts.approve_contacts), which the extension uses for that limit. Additive only.
create or replace function public.ext_dashboard(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  day_start timestamptz := date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'limits', outreach.limits(),
    'usage', (select to_jsonb(u) from outreach.v_today_usage u),
    'ai', jsonb_build_object(
      'today_usd', (select coalesce(sum(cost_usd), 0) from outreach.ai_calls where created_at >= day_start),
      'week_usd', (select coalesce(sum(cost_usd), 0) from outreach.ai_calls where created_at >= now() - interval '7 days'),
      'budget_usd', (outreach.ext_setting('ai_daily_budget_usd') #>> '{}')::numeric),
    'counts', jsonb_build_object(
      'approve', (select count(*) from outreach.action_queue where status = 'proposed'),
      -- proposed invites, messages and replies, without withdrawals (housekeeping, not new contacts)
      'approve_contacts', (select count(*) from outreach.action_queue where status = 'proposed' and action <> 'withdraw'),
      'approved', (select count(*) from outreach.action_queue where status = 'approved'),
      'leads', (select count(*) from outreach.candidates where verdict = 'staged'),
      'comments', (select count(*) from outreach.engagement where status = 'drafted'),
      'replies_open', (select count(*) from outreach.prospects where stage = 'replied' and reply_answered_at is null)),
    'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]') from
              (select id, kind, status, started_at, finished_at, left(notes, 200) notes from outreach.runs
               order by started_at desc limit 6) r));
end $$;

-- migrate:down
create or replace function public.ext_dashboard(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  day_start timestamptz := date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'limits', outreach.limits(),
    'usage', (select to_jsonb(u) from outreach.v_today_usage u),
    'ai', jsonb_build_object(
      'today_usd', (select coalesce(sum(cost_usd), 0) from outreach.ai_calls where created_at >= day_start),
      'week_usd', (select coalesce(sum(cost_usd), 0) from outreach.ai_calls where created_at >= now() - interval '7 days'),
      'budget_usd', (outreach.ext_setting('ai_daily_budget_usd') #>> '{}')::numeric),
    'counts', jsonb_build_object(
      'approve', (select count(*) from outreach.action_queue where status = 'proposed'),
      'approved', (select count(*) from outreach.action_queue where status = 'approved'),
      'leads', (select count(*) from outreach.candidates where verdict = 'staged'),
      'comments', (select count(*) from outreach.engagement where status = 'drafted'),
      'replies_open', (select count(*) from outreach.prospects where stage = 'replied' and reply_answered_at is null)),
    'runs', (select coalesce(jsonb_agg(to_jsonb(r) order by r.started_at desc), '[]') from
              (select id, kind, status, started_at, finished_at, left(notes, 200) notes from outreach.runs
               order by started_at desc limit 6) r));
end $$;
