-- migrate:up
-- Incoming connections (Jibran, 16.11.2026). People who connect with Jibran without the robot having
-- invited them (he accepted their request) used to be ignored by the sync round. Now:
--   1. The sync round records every new connection since inbound_since that is not a prospect yet.
--      Whether they asked: a manual invite by Jibran shows up on the Sent page first (sent_seen); a
--      person never seen there sent the request themselves.
--   2. The robot opens their profile and the fit check runs against each active campaign.
--   3. Fit: the person becomes a prospect at stage 'accepted' in that campaign. The campaign's first
--      message is replaced by a thank-you version (campaigns.raw->>'inbound_text', or the campaign text
--      with "danke für Ihre Vernetzungsanfrage") and waits for Jibran's approval: never auto-approved.
--      The campaign's later follow-ups run as usual.
--   4. No fit or unsure: listed in Leads (candidates.inbound) without a message. Approving such a lead
--      enrolls the person the same way instead of sending an invite.
-- Additive only.

create table if not exists outreach.inbound_connections (
  linkedin_url text primary key,
  full_name text,
  headline text,
  connected_on date,
  asked boolean not null default true,
  status text not null default 'new'
    check (status in ('new', 'fit', 'no_fit', 'unsure', 'existing', 'failed')),
  campaign_id text references outreach.campaigns(id) on delete set null,
  fit jsonb,
  prospect_id bigint references outreach.prospects(id) on delete set null,
  candidate_id bigint references outreach.candidates(id) on delete set null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);

-- Profiles seen on the Sent invitations page: Jibran (or the robot) invited them.
create table if not exists outreach.sent_seen (
  linkedin_url text primary key,
  first_seen timestamptz not null default now()
);

alter table outreach.candidates add column if not exists inbound boolean not null default false;

-- Only connections from today on: the thousands of older connections are never messaged.
insert into outreach.settings (key, value, note)
values ('inbound_since', to_jsonb(current_date::text)::text,
        'Connections from this day on that the robot did not invite get a fit check and a thank-you message for approval')
on conflict (key) do nothing;

-- Thank-you text for the broker campaign. _DANKE_ becomes "danke für Ihre Vernetzungsanfrage" when the
-- person sent the request, else "danke für die Vernetzung".
update outreach.campaigns set raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('inbound_text',
$t$Guten Tag _FN_, _DANKE_.

Kurz zu mir: Ich baue für Makler KI-Agenten, die wiederkehrende Büroarbeit übernehmen: Schaden aufnehmen, Angebot und Rechnung schreiben, den Posteingang sortieren und alles sauber ins MVP übertragen. Nach den Abläufen Ihres Büros, nicht von der Stange. Deutsche GmbH, Server in Deutschland.

Falls das für Sie interessant ist, zeige ich Ihnen in einer kurzen Demo, wie so ein Agent im Maklerbüro arbeitet. Oder Sie nennen mir zwei, drei Abläufe aus Ihrer Woche, und ich schicke Ihnen zurück, was ein Agent davon übernehmen könnte.

Beste Grüße
Jibran$t$)
where id = 'ki-agenten-makler' and not (coalesce(raw, '{}'::jsonb) ? 'inbound_text');

-- The thank-you text for one person.
create or replace function outreach.inbound_text(p_campaign text, p_campaign_text text, p_first_name text, p_asked boolean)
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_custom text := (select raw->>'inbound_text' from outreach.campaigns where id = p_campaign);
  v_thanks text := case when p_asked then 'danke für Ihre Vernetzungsanfrage' else 'danke für die Vernetzung' end;
  v text;
begin
  if nullif(trim(v_custom), '') is not null then
    v := replace(replace(v_custom, '_DANKE_', v_thanks), '_FN_', coalesce(p_first_name, ''));
  else
    v := coalesce(p_campaign_text, '');
    if p_asked then
      v := regexp_replace(v, 'danke für die Vernetzung', 'danke für Ihre Vernetzungsanfrage', 'i');
    end if;
  end if;
  return nullif(v, '');
end $$;

-- Puts a connected person into a campaign: prospect at 'accepted' just after the campaign's connect
-- step, so the next step is the first message. That message gets the thank-you text and waits for
-- Jibran ('proposed', due now).
create or replace function outreach.inbound_enroll(
  p_url text, p_campaign text, p_full_name text, p_headline text, p_company text,
  p_connected_on date, p_asked boolean, p_fit jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_url text := outreach.norm_li_url(p_url);
  v_step int;
  v_pid bigint;
  v_stage text;
  v_q bigint;
  v_text text;
  v_fn text;
begin
  if v_url is null then raise exception 'no LinkedIn profile URL' using errcode = '22023'; end if;
  if not exists (select 1 from outreach.campaigns where id = p_campaign and status = 'on') then
    raise exception 'campaign % is not active', p_campaign using errcode = '22023';
  end if;
  select coalesce(max(step) filter (where action_type = 'connect'), 0) into v_step
    from outreach.campaign_actions where campaign_id = p_campaign;

  select id, stage into v_pid, v_stage from outreach.prospects where linkedin_url = v_url for update;
  if v_pid is not null and v_stage not in ('found', 'approved', 'visited') then
    return jsonb_build_object('enrolled', false, 'prospect_id', v_pid, 'reason', 'already a prospect (' || v_stage || ')');
  end if;

  if v_pid is null then
    insert into outreach.prospects (linkedin_url, full_name, first_name, last_name, headline, company,
                                    campaign_id, campaign_step, stage, source, accepted_at, enrolled_at, degree, raw, notes)
    values (v_url, p_full_name, split_part(coalesce(p_full_name, ''), ' ', 1),
            nullif(regexp_replace(coalesce(p_full_name, ''), '^\S+\s*', ''), ''), p_headline, p_company,
            p_campaign, v_step, 'accepted', 'inbound', coalesce(p_connected_on::timestamptz, now()), now(), '1st',
            jsonb_build_object('fit', p_fit, 'inbound', jsonb_build_object('asked', p_asked)),
            case when p_asked then 'sent Jibran a connection request' else 'connected with Jibran' end)
    returning id into v_pid;
  else
    -- Found earlier by prospecting, but connected before the robot invited: no invite any more.
    update outreach.action_queue set status = 'cancelled', error = 'auto: connected on their own'
      where prospect_id = v_pid and status in ('scheduled', 'proposed', 'approved');
    update outreach.prospects set campaign_id = p_campaign, campaign_step = v_step, stage = 'accepted',
           accepted_at = coalesce(p_connected_on::timestamptz, now()), enrolled_at = coalesce(enrolled_at, now()),
           raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('inbound', jsonb_build_object('asked', p_asked))
             || case when p_fit is null then '{}'::jsonb else jsonb_build_object('fit', p_fit) end
     where id = v_pid;
  end if;

  -- schedule_next (stage trigger) queued the campaign's first message; turn it into the thank-you.
  select q.id, q.message_text into v_q, v_text from outreach.action_queue q
   where q.prospect_id = v_pid and q.action in ('message', 'inmail') and q.status = 'scheduled'
   order by q.step limit 1;
  select coalesce(nullif(first_name, ''), split_part(coalesce(full_name, ''), ' ', 1)) into v_fn
    from outreach.prospects where id = v_pid;
  if v_q is not null then
    update outreach.action_queue set
      message_text = coalesce(outreach.inbound_text(p_campaign, v_text, v_fn, p_asked), v_text),
      status = 'proposed', due_at = now(), error = null
    where id = v_q;
  end if;
  insert into outreach.events (prospect_id, campaign_id, event_type, detail)
  values (v_pid, p_campaign, 'accepted', jsonb_build_object('source', 'inbound', 'asked', p_asked));
  return jsonb_build_object('enrolled', true, 'prospect_id', v_pid, 'queue_id', v_q);
end $$;

-- Called by POST /ext/sync after the usual matching. p_connections: [{url, name, headline, connectedOn}],
-- p_sent: [url]. Returns who still needs a fit check (at most 3 per round).
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

-- The fit check result for one new connection. p_result: {status: fit|no_fit|unsure|failed,
-- campaign_id, fit, name, headline, company, reason}.
create or replace function public.ext_inbound_assessed(p_user_id uuid, p_url text, p_result jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  i outreach.inbound_connections;
  v_status text := p_result->>'status';
  v_enroll jsonb;
  v_cand bigint;
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into i from outreach.inbound_connections where linkedin_url = outreach.norm_li_url(p_url) for update;
  if not found then raise exception 'unknown connection' using errcode = 'P0002'; end if;
  if v_status not in ('fit', 'no_fit', 'unsure', 'failed') then
    raise exception 'unknown status %', v_status using errcode = '22023';
  end if;
  update outreach.inbound_connections set
    full_name = coalesce(nullif(p_result->>'name', ''), full_name),
    headline = coalesce(nullif(p_result->>'headline', ''), headline),
    attempts = attempts + 1, checked_at = now(), fit = p_result->'fit'
  where linkedin_url = i.linkedin_url
  returning * into i;

  if v_status = 'failed' then
    if i.attempts >= 3 then update outreach.inbound_connections set status = 'failed' where linkedin_url = i.linkedin_url; end if;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  if v_status = 'fit' then
    v_enroll := outreach.inbound_enroll(i.linkedin_url, p_result->>'campaign_id', i.full_name, i.headline,
      nullif(p_result->>'company', ''), i.connected_on, i.asked, p_result->'fit');
    if (v_enroll->>'enrolled')::boolean then
      update outreach.inbound_connections set status = 'fit', campaign_id = p_result->>'campaign_id',
             prospect_id = (v_enroll->>'prospect_id')::bigint
       where linkedin_url = i.linkedin_url;
      return jsonb_build_object('ok', true, 'status', 'fit', 'prospect_id', v_enroll->'prospect_id', 'queue_id', v_enroll->'queue_id');
    end if;
    update outreach.inbound_connections set status = 'existing', prospect_id = (v_enroll->>'prospect_id')::bigint
     where linkedin_url = i.linkedin_url;
    return jsonb_build_object('ok', true, 'status', 'existing');
  end if;

  -- No fit or unsure: a lead for Jibran to decide, without a message.
  insert into outreach.candidates (full_name, headline, company, linkedin_url, keyword, verdict, campaign_id, reason, inbound)
  values (i.full_name, i.headline, nullif(p_result->>'company', ''), i.linkedin_url,
          case when i.asked then 'Anfrage an dich' else 'Neue Verbindung' end, 'staged',
          nullif(p_result->>'campaign_id', ''),
          left(concat_ws(': ', case when i.asked then 'sent you a connection request' else 'new connection' end,
                         nullif(p_result->>'reason', '')), 1000), true)
  returning id into v_cand;
  update outreach.inbound_connections set status = v_status, candidate_id = v_cand where linkedin_url = i.linkedin_url;
  return jsonb_build_object('ok', true, 'status', v_status, 'candidate_id', v_cand);
end $$;

-- Leads: also says whether the lead is a new connection.
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

-- Approving a lead that is a new connection enrolls it (thank-you message for approval), never an invite.
create or replace function public.ext_review_lead(p_user_id uuid, p_candidate_id bigint, p_decision text, p_campaign_id text, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  c outreach.candidates;
  v_url text;
  v_campaign text;
  v_pid bigint;
  v_in outreach.inbound_connections;
  v_enroll jsonb;
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into c from outreach.candidates where id = p_candidate_id for update;
  if not found then raise exception 'unknown candidate' using errcode = 'P0002'; end if;
  if p_decision = 'reject' then
    update outreach.candidates set verdict = 'rejected',
      reason = concat_ws(' | ', reason, 'rejected in extension: ' || coalesce(nullif(p_reason, ''), 'no reason given'))
    where id = p_candidate_id;
    return jsonb_build_object('ok', true, 'verdict', 'rejected');
  elsif p_decision <> 'approve' then
    raise exception 'unknown decision %', p_decision using errcode = '22023';
  end if;

  v_url := outreach.norm_li_url(c.linkedin_url);
  v_campaign := coalesce(nullif(p_campaign_id, ''), c.campaign_id);
  if v_url is null then raise exception 'candidate has no LinkedIn profile URL' using errcode = '22023'; end if;
  if v_campaign is null or not exists (select 1 from outreach.campaigns where id = v_campaign and status <> 'archived') then
    raise exception 'choose an active campaign' using errcode = '22023';
  end if;

  if c.inbound then
    select * into v_in from outreach.inbound_connections where linkedin_url = v_url;
    v_enroll := outreach.inbound_enroll(v_url, v_campaign, c.full_name, c.headline, c.company,
      v_in.connected_on, coalesce(v_in.asked, true), v_in.fit);
    if not (v_enroll->>'enrolled')::boolean then
      update outreach.candidates set verdict = 'duplicate', reason = concat_ws(' | ', reason, v_enroll->>'reason')
      where id = p_candidate_id;
      return jsonb_build_object('ok', true, 'verdict', 'duplicate');
    end if;
    update outreach.candidates set verdict = 'approved', campaign_id = v_campaign where id = p_candidate_id;
    update outreach.inbound_connections set status = 'fit', campaign_id = v_campaign,
           prospect_id = (v_enroll->>'prospect_id')::bigint where linkedin_url = v_url;
    return jsonb_build_object('ok', true, 'verdict', 'approved', 'prospect_id', v_enroll->'prospect_id',
                              'message', 'thank-you message waits for approval');
  end if;

  if exists (select 1 from outreach.prospects where linkedin_url = v_url) then
    update outreach.candidates set verdict = 'duplicate', reason = concat_ws(' | ', reason, 'already a prospect')
    where id = p_candidate_id;
    return jsonb_build_object('ok', true, 'verdict', 'duplicate');
  end if;

  insert into outreach.prospects (linkedin_url, full_name, first_name, last_name, headline, company, segment, score,
                                  campaign_id, stage, source, notes, company_id)
  values (v_url, c.full_name, split_part(coalesce(c.full_name, ''), ' ', 1),
          nullif(regexp_replace(coalesce(c.full_name, ''), '^\S+\s*', ''), ''), c.headline, c.company, c.segment, c.score,
          v_campaign, 'approved', 'extension-lead', 'lead approved in extension: ' || coalesce(c.reason, ''), c.company_id)
  returning id into v_pid;
  update outreach.candidates set verdict = 'approved', campaign_id = v_campaign where id = p_candidate_id;
  insert into outreach.events (prospect_id, campaign_id, event_type, detail)
  values (v_pid, v_campaign, 'found', jsonb_build_object('source', 'extension-lead', 'candidate_id', p_candidate_id));
  return jsonb_build_object('ok', true, 'verdict', 'approved', 'prospect_id', v_pid);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_inbound_record(uuid,jsonb,jsonb)', 'ext_inbound_assessed(uuid,text,jsonb)',
                           'ext_list_leads(uuid)', 'ext_review_lead(uuid,bigint,text,text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_inbound_assessed(uuid, text, jsonb);
drop function if exists public.ext_inbound_record(uuid, jsonb, jsonb);
drop function if exists outreach.inbound_enroll(text, text, text, text, text, date, boolean, jsonb);
drop function if exists outreach.inbound_text(text, text, text, boolean);
drop table if exists outreach.inbound_connections;
drop table if exists outreach.sent_seen;
delete from outreach.settings where key = 'inbound_since';
update outreach.campaigns set raw = raw - 'inbound_text' where raw ? 'inbound_text';
-- ext_list_leads and ext_review_lead: the definitions in 20261113000050_company_signals.sql apply again
-- after re-running that migration's up section.
alter table outreach.candidates drop column if exists inbound;
