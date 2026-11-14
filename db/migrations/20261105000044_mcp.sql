-- migrate:up
-- MCP server (Jibran, 05.11.2026): Claude reads, reports and reviews through /mcp. Additive only.

-- Who reviewed a comment draft: null = side panel (as before), 'mcp' = Claude after Jibran's yes in chat.
alter table outreach.engagement add column if not exists reviewed_via text;

-- Marks a review made through the MCP server (called right after ext_review_queue / ext_review_comment).
create or replace function public.ext_mcp_mark(p_user_id uuid, p_kind text, p_id bigint)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_kind = 'queue' then
    update outreach.action_queue set approved_via = 'mcp' where id = p_id and status = 'approved';
  elsif p_kind = 'comment' then
    update outreach.engagement set reviewed_via = 'mcp' where id = p_id;
  else
    raise exception 'unknown kind %', p_kind using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Numbers for the weekly report (the "linkedin-weekly-report" routine): per campaign, per week, replies
-- waiting for an answer, the baseline from before the robot, robot jobs and comments in the period.
create or replace function public.ext_mcp_report(p_user_id uuid, p_weeks int)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  v_weeks int := least(greatest(coalesce(p_weeks, 2), 1), 12);
  v_from timestamptz := date_trunc('week', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'
                        - make_interval(weeks => v_weeks - 1);
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'period_from', v_from,
    'campaigns', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('status', c.status, 'name', c.name)
                                            order by s.invited desc), '[]')
                  from outreach.v_campaign_stats s left join outreach.campaigns c on c.id = s.campaign_id),
    'weekly', (select coalesce(jsonb_agg(to_jsonb(w) order by w.week desc, w.campaign_id), '[]')
               from outreach.v_weekly_activity w where w.week >= (v_from at time zone 'Europe/Berlin')::date),
    'replies_waiting', (select coalesce(jsonb_agg(jsonb_build_object(
                          'name', p.full_name, 'company', p.company, 'campaign', p.campaign_id,
                          'replied_at', p.replied_at, 'outcome', p.reply_outcome, 'priority', p.reply_priority,
                          'snippet', left(p.reply_snippet, 300), 'profile', p.linkedin_url)
                          order by p.reply_priority nulls last, p.replied_at), '[]')
                        from (select * from outreach.prospects
                              where replied_at is not null and reply_answered_at is null
                                and stage not in ('completed', 'withdrawn', 'blacklisted')
                              order by reply_priority nulls last, replied_at limit 30) p),
    'baseline', (select d.data from outreach.legacy_snapshots d where d.kind = 'kpi' and d.key = '*'),
    'jobs', (select coalesce(jsonb_object_agg(k, n), '{}') from (
               select kind || ':' || status as k, count(*) as n from outreach.ext_jobs
               where created_at >= v_from group by kind, status) j),
    'limit_warnings', (select count(*) from outreach.events where event_type = 'limit_warning' and occurred_at >= v_from),
    'send_failures', (select count(*) from outreach.events where event_type = 'send_failed' and occurred_at >= v_from),
    'comments', (select coalesce(jsonb_object_agg(status, n), '{}') from (
                   select status, count(*) as n from outreach.engagement
                   where coalesce(posted_at, reviewed_at, created_at) >= v_from group by status) e),
    'dashboard', outreach_dashboard_or_null(p_user_id)
  );
end $$;

-- ext_dashboard is called for the limits (pending invites, weekly cap); kept separate so a change there
-- cannot break the report.
create or replace function public.outreach_dashboard_or_null(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  return public.ext_dashboard(p_user_id);
exception when others then
  return null;
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_mcp_mark(uuid,text,bigint)', 'ext_mcp_report(uuid,integer)',
                           'outreach_dashboard_or_null(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_mcp_report(uuid, integer);
drop function if exists public.outreach_dashboard_or_null(uuid);
drop function if exists public.ext_mcp_mark(uuid, text, bigint);
alter table outreach.engagement drop column if exists reviewed_via;
