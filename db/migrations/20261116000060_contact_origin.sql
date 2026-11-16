-- migrate:up
-- Who asked whom (Jibran, 16.11.2026). Until now a new connection counted as "they sent the request"
-- whenever the robot had not seen the person on the Sent invitations page. That misses hand-sent invites
-- accepted before the next sync, and more than ~10 sent between two syncs. Now the sync also reads the
-- Invitations received page (read only; accepting stays Jibran's click):
--   seen on Received  -> origin 'requested' (they asked): "danke für Ihre Vernetzungsanfrage"
--   seen on Sent      -> origin 'invited' (Jibran invited by hand): "danke für die Vernetzung"
--   seen on neither   -> origin 'unknown': the neutral "danke für die Vernetzung"
-- Approve and Leads show the origin, 'robot' for the app's own invites. Additive only.

create table if not exists outreach.received_seen (
  linkedin_url text primary key,
  first_seen timestamptz not null default now()
);

alter table outreach.inbound_connections add column if not exists origin text not null default 'unknown'
  check (origin in ('requested', 'invited', 'unknown'));
-- Rows recorded by the old rule: "not on Sent" was a guess, so it becomes unknown; not yet enrolled
-- ones also lose the "you asked" wording.
update outreach.inbound_connections set origin = case when asked then 'unknown' else 'invited' end
 where origin = 'unknown';
update outreach.inbound_connections set asked = false where origin = 'unknown' and status = 'new';
alter table outreach.inbound_connections alter column asked set default false;

-- p_received: profile URLs on the Invitations received page.
create or replace function public.ext_inbound_record(p_user_id uuid, p_connections jsonb, p_sent jsonb, p_received jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  v_since date := coalesce(nullif(outreach.ext_setting('inbound_since') #>> '{}', '')::date, current_date);
  r jsonb;
  v_url text;
  v_on date;
  v_stage text;
  v_pid bigint;
  v_origin text;
  n_new int := 0;
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.sent_seen (linkedin_url)
  select distinct outreach.norm_li_url(u) from jsonb_array_elements_text(coalesce(p_sent, '[]')) u
   where outreach.norm_li_url(u) is not null
  on conflict do nothing;
  insert into outreach.received_seen (linkedin_url)
  select distinct outreach.norm_li_url(u) from jsonb_array_elements_text(coalesce(p_received, '[]')) u
   where outreach.norm_li_url(u) is not null
  on conflict do nothing;

  for r in select * from jsonb_array_elements(coalesce(p_connections, '[]')) loop
    v_url := outreach.norm_li_url(r->>'url');
    v_on := case when r->>'connectedOn' ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'connectedOn')::date end;
    continue when v_url is null or v_on is null or v_on < v_since;
    continue when exists (select 1 from outreach.inbound_connections where linkedin_url = v_url);
    v_origin := case
      when exists (select 1 from outreach.received_seen s where s.linkedin_url = v_url) then 'requested'
      when exists (select 1 from outreach.sent_seen s where s.linkedin_url = v_url) then 'invited'
      else 'unknown' end;
    select id, stage into v_pid, v_stage from outreach.prospects where linkedin_url = v_url;
    insert into outreach.inbound_connections (linkedin_url, full_name, headline, connected_on, asked, origin, status, prospect_id)
    values (v_url, r->>'name', nullif(r->>'headline', ''), v_on, v_origin = 'requested', v_origin,
            case when v_pid is null then 'new' else 'existing' end, v_pid);
    n_new := n_new + 1;
    -- A prospect found earlier (not yet invited) who connected first: enroll with the fit already known.
    if v_pid is not null and v_stage in ('found', 'approved', 'visited')
       and exists (select 1 from outreach.prospects p join outreach.campaigns c on c.id = p.campaign_id
                   where p.id = v_pid and c.status = 'on') then
      perform outreach.inbound_enroll(v_url, (select campaign_id from outreach.prospects where id = v_pid),
        r->>'name', nullif(r->>'headline', ''), null, v_on, v_origin = 'requested', null);
      update outreach.inbound_connections set status = 'fit',
             campaign_id = (select campaign_id from outreach.prospects where id = v_pid), checked_at = now()
       where linkedin_url = v_url;
    end if;
  end loop;

  return jsonb_build_object('added', n_new, 'to_check',
    (select coalesce(jsonb_agg(jsonb_build_object('url', linkedin_url, 'name', full_name) order by connected_on desc), '[]')
       from (select * from outreach.inbound_connections where status = 'new' and attempts < 3
             order by connected_on desc limit 3) x));
end $$;

-- The 3-argument form (an extension that does not read the Received page yet).
create or replace function public.ext_inbound_record(p_user_id uuid, p_connections jsonb, p_sent jsonb)
returns jsonb
language sql security definer
set search_path = outreach, public
as $$ select public.ext_inbound_record(p_user_id, p_connections, p_sent, '[]'::jsonb) $$;

-- Where a contact came from: 'robot' (invited by the app), 'requested', 'invited' (by hand), 'unknown'.
create or replace function outreach.contact_origin(p_url text, p_source text, p_raw jsonb)
returns text
language sql stable
set search_path = ''
as $$
  -- 'existing' rows are people who were contacts already when they connected (usually robot invites)
  select coalesce(
    (select i.origin from outreach.inbound_connections i where i.linkedin_url = p_url and i.status <> 'existing'),
    case when p_source = 'inbound' or p_raw ? 'inbound' then
      case when (p_raw->'inbound'->>'asked')::boolean then 'requested' else 'unknown' end
    else 'robot' end)
$$;

create or replace function public.ext_list_queue(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.status desc, x.action, x.due_at), '[]') from (
    select q.id, q.action, q.step, q.status, q.due_at, q.message_text, q.campaign_id, q.approved_at, q.error,
           p.id as prospect_id, p.full_name, p.first_name, p.headline, p.company, p.linkedin_url, p.stage,
           p.reply_snippet, p.replied_at, p.raw->'fit' as fit, p.raw->'trigger' as trigger,
           p.reply_outcome, p.reply_reason,
           outreach.contact_origin(p.linkedin_url, p.source, p.raw) as origin
    from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
    where q.status in ('proposed', 'approved')
    order by q.due_at limit 200) x);
end $$;

create or replace function public.ext_list_leads(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.verdict desc, x.found_at desc), '[]') from (
    select c.id, c.found_at, c.full_name, c.headline, c.company, c.linkedin_url, c.segment, c.keyword, c.score,
           c.verdict, c.campaign_id, c.reason, c.company_id, c.inbound,
           case when c.inbound then coalesce(
             (select i.origin from outreach.inbound_connections i where i.candidate_id = c.id
               order by i.created_at desc limit 1), 'unknown')
           else 'robot' end as origin,
           (select co.domain from outreach.companies co where co.id = c.company_id) as company_domain,
           outreach.company_signals(c.company_id) as signals
    from outreach.candidates c
    where c.verdict = 'staged' or (c.verdict = 'approved' and c.found_at > now() - interval '7 days')
    order by c.found_at desc limit 200) x);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_inbound_record(uuid,jsonb,jsonb,jsonb)', 'ext_inbound_record(uuid,jsonb,jsonb)',
                           'ext_list_queue(uuid)', 'ext_list_leads(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_inbound_record(uuid, jsonb, jsonb, jsonb);
create or replace function public.ext_inbound_record(p_user_id uuid, p_connections jsonb, p_sent jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  v_since date := coalesce(nullif(outreach.ext_setting('inbound_since') #>> '{}', '')::date, current_date);
  r jsonb;
  v_url text;
  v_on date;
  v_stage text;
  v_pid bigint;
  n_new int := 0;
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.sent_seen (linkedin_url)
  select distinct outreach.norm_li_url(u) from jsonb_array_elements_text(coalesce(p_sent, '[]')) u
   where outreach.norm_li_url(u) is not null
  on conflict do nothing;

  for r in select * from jsonb_array_elements(coalesce(p_connections, '[]')) loop
    v_url := outreach.norm_li_url(r->>'url');
    v_on := case when r->>'connectedOn' ~ '^\d{4}-\d{2}-\d{2}$' then (r->>'connectedOn')::date end;
    continue when v_url is null or v_on is null or v_on < v_since;
    continue when exists (select 1 from outreach.inbound_connections where linkedin_url = v_url);
    select id, stage into v_pid, v_stage from outreach.prospects where linkedin_url = v_url;
    insert into outreach.inbound_connections (linkedin_url, full_name, headline, connected_on, asked, status, prospect_id)
    values (v_url, r->>'name', nullif(r->>'headline', ''), v_on,
            not exists (select 1 from outreach.sent_seen s where s.linkedin_url = v_url),
            case when v_pid is null then 'new' else 'existing' end, v_pid);
    n_new := n_new + 1;
    -- A prospect found earlier (not yet invited) who connected first: enroll with the fit already known.
    if v_pid is not null and v_stage in ('found', 'approved', 'visited')
       and exists (select 1 from outreach.prospects p join outreach.campaigns c on c.id = p.campaign_id
                   where p.id = v_pid and c.status = 'on') then
      perform outreach.inbound_enroll(v_url, (select campaign_id from outreach.prospects where id = v_pid),
        r->>'name', nullif(r->>'headline', ''), null, v_on,
        not exists (select 1 from outreach.sent_seen s where s.linkedin_url = v_url), null);
      update outreach.inbound_connections set status = 'fit',
             campaign_id = (select campaign_id from outreach.prospects where id = v_pid), checked_at = now()
       where linkedin_url = v_url;
    end if;
  end loop;

  return jsonb_build_object('added', n_new, 'to_check',
    (select coalesce(jsonb_agg(jsonb_build_object('url', linkedin_url, 'name', full_name) order by connected_on desc), '[]')
       from (select * from outreach.inbound_connections where status = 'new' and attempts < 3
             order by connected_on desc limit 3) x));
end $$;

create or replace function public.ext_list_queue(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.status desc, x.action, x.due_at), '[]') from (
    select q.id, q.action, q.step, q.status, q.due_at, q.message_text, q.campaign_id, q.approved_at, q.error,
           p.id as prospect_id, p.full_name, p.first_name, p.headline, p.company, p.linkedin_url, p.stage,
           p.reply_snippet, p.replied_at, p.raw->'fit' as fit, p.raw->'trigger' as trigger,
           p.reply_outcome, p.reply_reason
    from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
    where q.status in ('proposed', 'approved')
    order by q.due_at limit 200) x);
end $$;

create or replace function public.ext_list_leads(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.verdict desc, x.found_at desc), '[]') from (
    select c.id, c.found_at, c.full_name, c.headline, c.company, c.linkedin_url, c.segment, c.keyword, c.score,
           c.verdict, c.campaign_id, c.reason, c.company_id, c.inbound,
           (select co.domain from outreach.companies co where co.id = c.company_id) as company_domain,
           outreach.company_signals(c.company_id) as signals
    from outreach.candidates c
    where c.verdict = 'staged' or (c.verdict = 'approved' and c.found_at > now() - interval '7 days')
    order by c.found_at desc limit 200) x);
end $$;

drop function if exists outreach.contact_origin(text, text, jsonb);
alter table outreach.inbound_connections alter column asked set default true;
alter table outreach.inbound_connections drop column if exists origin;
drop table if exists outreach.received_seen;
