-- migrate:up
-- Baseline: the outreach schema as it exists in the Supabase project (PostgreSQL 17.6),
-- reconstructed from the catalog on 08.10.2026 (tables, constraints, indexes, views, functions, triggers).
-- Supabase-specific parts: none found (no auth/vault/cron/net references, no grants or policies for
-- anon/authenticated, no cross-schema foreign keys). Intentionally left out: the one-off
-- importer for the previous tool's CSV export (the import is done; import_raw is kept, empty).
-- Data is not part of this file; it is copied with scripts/import-supabase.sh.

create schema if not exists outreach;

-- Sequences ---------------------------------------------------------------------------------------
create sequence outreach.action_queue_id_seq as bigint;
create sequence outreach.candidates_id_seq as bigint;
create sequence outreach.docs_id_seq as bigint;
create sequence outreach.legacy_actions_id_seq as bigint;
create sequence outreach.events_id_seq as bigint;
create sequence outreach.messages_id_seq as bigint;
create sequence outreach.prospects_id_seq as bigint;
create sequence outreach.runs_id_seq as bigint;

-- Tables ------------------------------------------------------------------------------------------
create table outreach.settings (
  key text not null,
  value text not null,
  note text,
  updated_at timestamp with time zone default now() not null,
  constraint settings_pkey primary key (key)
);

create table outreach.campaigns (
  id text not null,
  name text not null,
  description text,
  status text default 'off'::text not null,
  language text default 'de'::text,
  invite_note text,
  msg1_text text,
  msg1_delay_hours integer default 4 not null,
  msg2_text text,
  msg2_delay_days integer default 7 not null,
  msg3_text text,
  msg3_delay_days integer default 7 not null,
  daily_invite_share integer,
  source text default 'manual'::text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  raw jsonb,
  target text default 'regular'::text,
  exclusive boolean default true,
  smart boolean default true,
  enrollandtag boolean default true,
  reject_connected_profiles boolean default true,
  constraint campaigns_pkey primary key (id),
  constraint campaigns_status_check check ((status = any (array['on'::text, 'off'::text, 'archived'::text])))
);

create table outreach.campaign_actions (
  campaign_id text not null,
  step integer not null,
  action_type text not null,
  text text,
  subject text,
  skills integer,
  delay interval default '00:00:00'::interval not null,
  constraint campaign_actions_pkey primary key (campaign_id, step),
  constraint campaign_actions_action_type_check check ((action_type = any (array['visit'::text, 'connect'::text, 'message'::text, 'inmail'::text, 'follow'::text, 'endorse'::text, 'likepost'::text, 'disconnect'::text]))),
  constraint campaign_actions_step_check check ((step >= 1))
);

create table outreach.prospects (
  id bigint default nextval('outreach.prospects_id_seq'::regclass) not null,
  linkedin_url text not null,
  public_id text,
  legacy_id text,
  first_name text,
  last_name text,
  full_name text,
  headline text,
  company text,
  location text,
  segment text,
  score integer,
  campaign_id text,
  stage text default 'found'::text not null,
  found_at timestamp with time zone default now(),
  visited_at timestamp with time zone,
  invited_at timestamp with time zone,
  accepted_at timestamp with time zone,
  msg1_at timestamp with time zone,
  msg2_at timestamp with time zone,
  msg3_at timestamp with time zone,
  replied_at timestamp with time zone,
  closed_at timestamp with time zone,
  last_checked_at timestamp with time zone,
  reply_snippet text,
  qualified text,
  notes text,
  source text default 'search'::text,
  raw jsonb,
  updated_at timestamp with time zone default now() not null,
  email text,
  phone text,
  industry text,
  degree text,
  connections integer,
  company_url text,
  company_website text,
  sales_profile_url text,
  picture_url text,
  tags text[],
  campaign_step integer default 0 not null,
  enrolled_at timestamp with time zone,
  last_action_at timestamp with time zone,
  reply_outcome text,
  reply_priority integer,
  reply_reason text,
  reply_answered_at timestamp with time zone,
  reply_reviewed_at timestamp with time zone,
  last_post_at timestamp with time zone,
  last_post_url text,
  last_post_snippet text,
  activity_checked_at timestamp with time zone,
  constraint prospects_pkey primary key (id),
  constraint prospects_linkedin_url_key unique (linkedin_url),
  constraint prospects_legacy_id_key unique (legacy_id),
  constraint prospects_qualified_check check ((qualified = any (array['in'::text, 'out'::text]))),
  constraint prospects_reply_outcome_check check ((reply_outcome = any (array['interested'::text, 'not_now'::text, 'not_interested'::text, 'wrong_target'::text, 'question'::text, 'other'::text]))),
  constraint prospects_reply_priority_check check (((reply_priority >= 1) and (reply_priority <= 3))),
  constraint prospects_stage_check check ((stage = any (array['found'::text, 'approved'::text, 'visited'::text, 'invited'::text, 'accepted'::text, 'msg1_sent'::text, 'msg2_sent'::text, 'msg3_sent'::text, 'replied'::text, 'completed'::text, 'withdrawn'::text, 'skipped'::text, 'blacklisted'::text, 'already_connected'::text])))
);

create table outreach.runs (
  id bigint default nextval('outreach.runs_id_seq'::regclass) not null,
  kind text not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  status text default 'running'::text not null,
  summary jsonb,
  notes text,
  constraint runs_pkey primary key (id),
  constraint runs_status_check check ((status = any (array['running'::text, 'ok'::text, 'partial'::text, 'failed'::text, 'aborted'::text])))
);

create table outreach.action_queue (
  id bigint default nextval('outreach.action_queue_id_seq'::regclass) not null,
  prospect_id bigint not null,
  campaign_id text,
  action text not null,
  message_text text,
  due_at timestamp with time zone default now() not null,
  status text default 'scheduled'::text not null,
  prepared_run_id bigint,
  executed_run_id bigint,
  created_at timestamp with time zone default now() not null,
  approved_at timestamp with time zone,
  executed_at timestamp with time zone,
  error text,
  step integer,
  subject text,
  approved_via text,
  template_text text,
  personalization jsonb,
  constraint action_queue_pkey primary key (id),
  constraint action_queue_action_check check ((action = any (array['visit'::text, 'connect'::text, 'message'::text, 'inmail'::text, 'follow'::text, 'endorse'::text, 'likepost'::text, 'disconnect'::text, 'withdraw'::text, 'reply'::text]))),
  constraint action_queue_status_check check ((status = any (array['scheduled'::text, 'proposed'::text, 'approved'::text, 'done'::text, 'failed'::text, 'cancelled'::text, 'skipped'::text])))
);

create table outreach.events (
  id bigint default nextval('outreach.events_id_seq'::regclass) not null,
  prospect_id bigint,
  campaign_id text,
  run_id bigint,
  event_type text not null,
  step text,
  ok boolean default true not null,
  message_text text,
  detail jsonb,
  occurred_at timestamp with time zone default now() not null,
  constraint events_pkey primary key (id),
  constraint events_event_type_check check ((event_type = any (array['found'::text, 'visit'::text, 'invite_sent'::text, 'invite_withdrawn'::text, 'accepted'::text, 'message_sent'::text, 'reply_detected'::text, 'skipped'::text, 'error'::text, 'stage_change'::text, 'imported'::text, 'limit_warning'::text])))
);

create table outreach.messages (
  id bigint default nextval('outreach.messages_id_seq'::regclass) not null,
  prospect_id bigint,
  legacy_id text,
  linkedin_url text,
  direction text,
  message_type text,
  sent_at timestamp with time zone,
  body text,
  source text default 'legacy-import'::text not null,
  raw jsonb,
  body_hash text generated always as (md5(coalesce(body, ''::text))) stored,
  constraint messages_pkey primary key (id),
  constraint messages_legacy_id_sent_at_direction_body_hash_key unique (legacy_id, sent_at, direction, body_hash),
  constraint messages_direction_check check ((direction = any (array['incoming'::text, 'outgoing'::text])))
);

create table outreach.docs (
  id bigint default nextval('outreach.docs_id_seq'::regclass) not null,
  doc_key text not null,
  version integer not null,
  content text not null,
  sha256 text not null,
  note text,
  created_at timestamp with time zone default now() not null,
  created_by text default 'claude'::text not null,
  constraint docs_pkey primary key (id),
  constraint docs_doc_key_version_key unique (doc_key, version)
);

create table outreach.candidates (
  id bigint default nextval('outreach.candidates_id_seq'::regclass) not null,
  run_id bigint,
  found_at timestamp with time zone default now() not null,
  full_name text,
  headline text,
  company text,
  linkedin_url text,
  segment text,
  keyword text,
  score integer,
  verdict text not null,
  campaign_id text,
  reason text,
  constraint candidates_pkey primary key (id),
  constraint candidates_verdict_check check ((verdict = any (array['approved'::text, 'staged'::text, 'rejected'::text, 'duplicate'::text])))
);

create table outreach.routines (
  kind text not null,
  name text not null,
  cron_utc text not null,
  schedule_label text not null,
  description text,
  sort integer default 0,
  constraint routines_pkey primary key (kind)
);

create table outreach.legacy_contacts (
  legacy_id text not null,
  linkedin_url text,
  sales_profile_url text,
  recruiter_profile_url text,
  first_name text,
  last_name text,
  title text,
  company text,
  company_url text,
  company_website text,
  email text,
  phone text,
  location text,
  industry text,
  degree text,
  connections text,
  employed_from text,
  tags text[],
  notes text,
  campaign_id text,
  picture_url text,
  last_seen_at timestamp with time zone,
  raw jsonb not null,
  imported_at timestamp with time zone default now() not null,
  constraint legacy_contacts_pkey primary key (legacy_id)
);

create table outreach.legacy_actions (
  id bigint default nextval('outreach.legacy_actions_id_seq'::regclass) not null,
  occurred_at timestamp with time zone not null,
  action_type text not null,
  legacy_id text,
  campaign_id text,
  success boolean,
  result text,
  raw jsonb,
  constraint legacy_actions_pkey primary key (id),
  constraint legacy_actions_occurred_at_action_type_legacy_id_key unique (occurred_at, action_type, legacy_id)
);

create table outreach.legacy_queue (
  messageid text not null,
  command text,
  legacy_id text,
  linkedin_url text,
  campaign_id text,
  action_index integer,
  attempt integer,
  message_text text,
  queued_at timestamp with time zone,
  raw jsonb not null,
  captured_at timestamp with time zone default now() not null,
  constraint legacy_queue_pkey primary key (messageid)
);

create table outreach.legacy_snapshots (
  kind text not null,
  key text not null,
  data jsonb not null,
  captured_at timestamp with time zone default now() not null,
  constraint legacy_snapshots_pkey primary key (kind, key)
);

create table outreach.import_raw (
  kind text not null,
  key text,
  raw jsonb not null
);

alter sequence outreach.prospects_id_seq owned by outreach.prospects.id;
alter sequence outreach.runs_id_seq owned by outreach.runs.id;
alter sequence outreach.action_queue_id_seq owned by outreach.action_queue.id;
alter sequence outreach.events_id_seq owned by outreach.events.id;
alter sequence outreach.docs_id_seq owned by outreach.docs.id;
alter sequence outreach.candidates_id_seq owned by outreach.candidates.id;
alter sequence outreach.legacy_actions_id_seq owned by outreach.legacy_actions.id;
alter sequence outreach.messages_id_seq owned by outreach.messages.id;

-- Foreign keys ------------------------------------------------------------------------------------
alter table outreach.action_queue add constraint action_queue_campaign_id_fkey foreign key (campaign_id) references outreach.campaigns(id);
alter table outreach.action_queue add constraint action_queue_executed_run_id_fkey foreign key (executed_run_id) references outreach.runs(id);
alter table outreach.action_queue add constraint action_queue_prepared_run_id_fkey foreign key (prepared_run_id) references outreach.runs(id);
alter table outreach.action_queue add constraint action_queue_prospect_id_fkey foreign key (prospect_id) references outreach.prospects(id) on delete cascade;
alter table outreach.campaign_actions add constraint campaign_actions_campaign_id_fkey foreign key (campaign_id) references outreach.campaigns(id) on delete cascade;
alter table outreach.candidates add constraint candidates_campaign_id_fkey foreign key (campaign_id) references outreach.campaigns(id) on delete set null;
alter table outreach.candidates add constraint candidates_run_id_fkey foreign key (run_id) references outreach.runs(id) on delete set null;
alter table outreach.events add constraint events_prospect_id_fkey foreign key (prospect_id) references outreach.prospects(id) on delete cascade;
alter table outreach.events add constraint events_run_id_fkey foreign key (run_id) references outreach.runs(id);
alter table outreach.messages add constraint messages_prospect_id_fkey foreign key (prospect_id) references outreach.prospects(id) on delete set null;
alter table outreach.prospects add constraint prospects_campaign_id_fkey foreign key (campaign_id) references outreach.campaigns(id);

-- Indexes -----------------------------------------------------------------------------------------
create unique index action_queue_one_open on outreach.action_queue using btree (prospect_id, action, coalesce(step, 0)) where (status = any (array['scheduled'::text, 'proposed'::text, 'approved'::text]));
create index action_queue_status_due_at_idx on outreach.action_queue using btree (status, due_at);
create index candidates_found_idx on outreach.candidates using btree (found_at desc);
create index candidates_run_idx on outreach.candidates using btree (run_id);
create index candidates_url_idx on outreach.candidates using btree (linkedin_url);
create index candidates_verdict_idx on outreach.candidates using btree (verdict);
create index docs_key_version_idx on outreach.docs using btree (doc_key, version desc);
create index legacy_actions_profile on outreach.legacy_actions using btree (legacy_id);
create index events_event_type_occurred_at_idx on outreach.events using btree (event_type, occurred_at);
create index events_prospect_id_idx on outreach.events using btree (prospect_id);
create index messages_prospect on outreach.messages using btree (prospect_id, sent_at);
create index prospects_campaign_id_stage_idx on outreach.prospects using btree (campaign_id, stage);
create index prospects_stage_idx on outreach.prospects using btree (stage);

-- Views -------------------------------------------------------------------------------------------
create view outreach.v_docs_current as
 select distinct on (doc_key) doc_key,
    version,
    content,
    sha256,
    note,
    created_at,
    created_by
   from outreach.docs
  order by doc_key, version desc;

create view outreach.v_campaign_stats as
 with p as (
         select prospects.id,
            prospects.linkedin_url,
            prospects.public_id,
            prospects.legacy_id,
            prospects.first_name,
            prospects.last_name,
            prospects.full_name,
            prospects.headline,
            prospects.company,
            prospects.location,
            prospects.segment,
            prospects.score,
            prospects.campaign_id,
            prospects.stage,
            prospects.found_at,
            prospects.visited_at,
            prospects.invited_at,
            prospects.accepted_at,
            prospects.msg1_at,
            prospects.msg2_at,
            prospects.msg3_at,
            prospects.replied_at,
            prospects.closed_at,
            prospects.last_checked_at,
            prospects.reply_snippet,
            prospects.qualified,
            prospects.notes,
            prospects.source,
            prospects.raw,
            prospects.updated_at,
            prospects.invited_at is not null or (prospects.stage = any (array['invited'::text, 'accepted'::text, 'msg1_sent'::text, 'msg2_sent'::text, 'msg3_sent'::text, 'replied'::text, 'completed'::text, 'withdrawn'::text])) as was_invited,
            prospects.accepted_at is not null or (prospects.stage = any (array['accepted'::text, 'msg1_sent'::text, 'msg2_sent'::text, 'msg3_sent'::text, 'completed'::text])) or prospects.stage = 'replied'::text and coalesce(prospects.raw::text, ''::text) ~~ '%-accepted%'::text as was_accepted,
            prospects.msg1_at is not null or (prospects.stage = any (array['msg1_sent'::text, 'msg2_sent'::text, 'msg3_sent'::text])) as was_messaged,
            prospects.replied_at is not null or prospects.stage = 'replied'::text as did_reply
           from outreach.prospects
        )
 select coalesce(campaign_id, '(none)'::text) as campaign_id,
    count(*) filter (where was_invited) as invited,
    count(*) filter (where was_accepted) as accepted,
    round(100.0 * count(*) filter (where was_accepted)::numeric / nullif(count(*) filter (where was_invited), 0)::numeric, 1) as accept_rate_pct,
    count(*) filter (where was_messaged) as messaged,
    count(*) filter (where did_reply) as replied,
    round(100.0 * count(*) filter (where did_reply)::numeric / nullif(count(*) filter (where was_accepted or did_reply), 0)::numeric, 1) as reply_rate_of_accepted_pct,
    round(100.0 * count(*) filter (where did_reply)::numeric / nullif(count(*) filter (where was_invited), 0)::numeric, 1) as invite_to_reply_pct,
    count(*) filter (where stage = 'invited'::text) as pending_invites,
    count(*) filter (where stage = any (array['accepted'::text, 'msg1_sent'::text, 'msg2_sent'::text])) as in_sequence,
    count(*) filter (where stage = 'withdrawn'::text) as withdrawn,
    count(*) filter (where qualified = 'in'::text) as qualified_in
   from p
  group by (coalesce(campaign_id, '(none)'::text));

create view outreach.v_candidates_by_run as
 select r.id as run_id,
    r.started_at,
    r.status,
    count(*) as seen,
    count(*) filter (where c.verdict = 'approved'::text) as approved,
    count(*) filter (where c.verdict = 'staged'::text) as staged,
    count(*) filter (where c.verdict = 'rejected'::text) as rejected,
    count(*) filter (where c.verdict = 'duplicate'::text) as duplicates
   from outreach.runs r
     join outreach.candidates c on c.run_id = r.id
  group by r.id, r.started_at, r.status
  order by r.started_at desc;

create view outreach.v_due_followups as
 select p.id as prospect_id,
    p.full_name,
    p.first_name,
    p.linkedin_url,
    p.campaign_id,
        case
            when p.stage = 'accepted'::text then 'msg1'::text
            when p.stage = 'msg1_sent'::text then 'msg2'::text
            when p.stage = 'msg2_sent'::text then 'msg3'::text
            else null::text
        end as next_action,
        case
            when p.stage = 'accepted'::text then p.accepted_at + make_interval(hours => c.msg1_delay_hours)
            when p.stage = 'msg1_sent'::text then p.msg1_at + make_interval(days => c.msg2_delay_days)
            when p.stage = 'msg2_sent'::text then p.msg2_at + make_interval(days => c.msg3_delay_days)
            else null::timestamp with time zone
        end as due_at,
        case
            when p.stage = 'accepted'::text then c.msg1_text
            when p.stage = 'msg1_sent'::text then c.msg2_text
            when p.stage = 'msg2_sent'::text then c.msg3_text
            else null::text
        end as template
   from outreach.prospects p
     join outreach.campaigns c on c.id = p.campaign_id
  where (p.stage = any (array['accepted'::text, 'msg1_sent'::text, 'msg2_sent'::text])) and p.replied_at is null and c.status = 'on'::text;

create view outreach.v_robot_due as
 select q.id as queue_id,
    q.status,
    q.action,
    q.step,
    q.due_at,
    q.message_text,
    q.subject,
    p.id as prospect_id,
    p.full_name,
    p.first_name,
    p.company,
    p.headline,
    p.linkedin_url,
    p.stage,
    q.campaign_id
   from outreach.action_queue q
     join outreach.prospects p on p.id = q.prospect_id
     left join outreach.campaigns c on c.id = q.campaign_id
  where (q.status = any (array['scheduled'::text, 'proposed'::text])) and q.due_at <= now() and (q.action = 'withdraw'::text or c.status = 'on'::text);

create view outreach.v_stale_invites as
 select id as prospect_id,
    full_name,
    linkedin_url,
    campaign_id,
    invited_at
   from outreach.prospects p
  where stage = 'invited'::text and invited_at < (now() - make_interval(days => ( select settings.value::integer as value
           from outreach.settings
          where settings.key = 'withdraw_after_days'::text)));

create view outreach.v_today_usage as
 select count(*) filter (where event_type = 'invite_sent'::text and ok and occurred_at >= (date_trunc('day'::text, (now() at time zone 'Europe/Berlin'::text)) at time zone 'Europe/Berlin'::text)) as invites_today,
    count(*) filter (where event_type = 'invite_sent'::text and ok and occurred_at >= (now() - '7 days'::interval)) as invites_7d,
    count(*) filter (where event_type = 'message_sent'::text and ok and occurred_at >= (date_trunc('day'::text, (now() at time zone 'Europe/Berlin'::text)) at time zone 'Europe/Berlin'::text)) as messages_today,
    count(*) filter (where event_type = 'visit'::text and ok and occurred_at >= (date_trunc('day'::text, (now() at time zone 'Europe/Berlin'::text)) at time zone 'Europe/Berlin'::text)) as visits_today,
    ( select count(*) as count
           from outreach.prospects
          where prospects.stage = 'invited'::text) as pending_invites
   from outreach.events;

create view outreach.v_weekly_activity as
 select date_trunc('week'::text, (occurred_at at time zone 'Europe/Berlin'::text))::date as week,
    campaign_id,
    count(*) filter (where event_type = 'invite_sent'::text and ok) as invites_sent,
    count(*) filter (where event_type = 'accepted'::text) as accepted,
    count(*) filter (where event_type = 'message_sent'::text and ok) as messages_sent,
    count(*) filter (where event_type = 'reply_detected'::text) as replies,
    count(*) filter (where not ok) as errors
   from outreach.events
  group by (date_trunc('week'::text, (occurred_at at time zone 'Europe/Berlin'::text))::date), campaign_id;

-- Functions ---------------------------------------------------------------------------------------
create or replace function outreach.touch_updated_at()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin new.updated_at = now(); return new; end $function$;

create or replace function outreach.url_decode(t text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select convert_from(decode(string_agg(
    case when m[1] ~ '^%[0-9A-Fa-f]{2}$' then substr(m[1], 2)
         else encode(convert_to(m[1], 'UTF8'), 'hex') end, '' order by ord), 'hex'), 'UTF8')
  from regexp_matches(t, '(%[0-9A-Fa-f]{2}|[^%]|%)', 'g') with ordinality as r(m, ord)
$function$;

create or replace function outreach.norm_li_url(t text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case when s is null then null else 'https://www.linkedin.com/in/' || s || '/' end
  from (select substring(outreach.url_decode(t) from '/in/([^/?#]+)') as s) x
$function$;

create or replace function outreach.doc(p_key text)
 returns text
 language sql
 stable
as $function$
  select content from outreach.v_docs_current where doc_key = p_key;
$function$;

create or replace function outreach.doc_put(p_key text, p_content text, p_note text default null::text, p_by text default 'claude'::text)
 returns integer
 language plpgsql
as $function$
declare
  v_sha  text := encode(sha256(convert_to(p_content, 'UTF8')), 'hex');
  v_cur  record;
  v_next integer;
begin
  select version, sha256 into v_cur from outreach.v_docs_current where doc_key = p_key;

  if found and v_cur.sha256 = v_sha then
    return v_cur.version;
  end if;

  v_next := coalesce(v_cur.version, 0) + 1;

  insert into outreach.docs (doc_key, version, content, sha256, note, created_by)
  values (p_key, v_next, p_content, v_sha, p_note, p_by);

  return v_next;
end;
$function$;

create or replace function outreach.limits()
 returns jsonb
 language plpgsql
 stable
 set search_path to ''
as $function$
declare
  tz text := 'Europe/Berlin';
  week_start timestamptz := date_trunc('week', now() at time zone tz) at time zone tz;
  next_monday timestamptz := (date_trunc('week', now() at time zone tz) + interval '7 days') at time zone tz;
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
  li_checked timestamptz := nullif(s->>'linkedin_pending_checked_at','')::timestamptz;
  inv_today int; inv_week int; msg_today int; db_pending int; pending int;
  until timestamptz; reason text := 'open';
begin
  if alert is not null then
    alert_until := greatest(alert + interval '7 days', (date_trunc('week', alert at time zone tz) + interval '7 days') at time zone tz);
  end if;
  select count(*) filter (where occurred_at >= day_start), count(*) into inv_today, inv_week
    from outreach.events where event_type = 'invite_sent' and ok and occurred_at >= week_start;
  select count(*) into msg_today from outreach.events where event_type = 'message_sent' and ok and occurred_at >= day_start;
  select count(*) into db_pending from outreach.prospects where stage = 'invited';
  pending := case when li_pending is not null and li_checked > now() - interval '2 days' then greatest(db_pending, li_pending) else db_pending end;

  if coalesce(s->>'paused','false') = 'true' then reason := 'robot_paused';
  elsif alert_until is not null and alert_until > now() then until := greatest(alert_until, coalesce(manual, alert_until)); reason := 'linkedin_warning';
  elsif manual is not null and manual > now() then until := manual; reason := 'paused_until';
  elsif inv_week >= w_cap then until := next_monday; reason := 'weekly_cap';
  elsif pending >= p_cap then reason := 'pending_cap';
  elsif inv_today >= d_cap then until := day_start + interval '1 day'; reason := 'daily_cap';
  end if;

  return jsonb_build_object(
    'invite_status', reason, 'invites_resume_at', until,
    'invites_allowed_now', case when reason = 'open' then greatest(0, least(d_cap - inv_today, w_cap - inv_week)) else 0 end,
    'invites_today', inv_today, 'daily_invite_cap', d_cap,
    'invites_this_week', inv_week, 'weekly_invite_cap', w_cap, 'week_started', week_start, 'next_week', next_monday,
    'messages_today', msg_today, 'daily_message_cap', m_cap,
    'messages_allowed_now', case when coalesce(s->>'paused','false') = 'true' then 0 else greatest(0, m_cap - msg_today) end,
    'pending_invites', pending, 'pending_invites_db', db_pending, 'pending_invites_linkedin', li_pending, 'pending_invite_cap', p_cap);
end $function$;

create or replace function outreach.schedule_next(p_id bigint)
 returns bigint
 language plpgsql
 set search_path to ''
as $function$
declare
  p outreach.prospects; c outreach.campaigns;
  nxt outreach.campaign_actions; prev outreach.campaign_actions;
  base timestamptz; q_id bigint; fn text; msg text;
begin
  select * into p from outreach.prospects where id = p_id;
  if not found or p.campaign_id is null then return null; end if;
  select * into c from outreach.campaigns where id = p.campaign_id;
  if c.status is distinct from 'on' then return null; end if;
  if p.stage in ('replied','withdrawn','skipped','blacklisted','already_connected','completed','found') then return null; end if;

  select * into prev from outreach.campaign_actions where campaign_id = p.campaign_id and step = p.campaign_step;
  select * into nxt  from outreach.campaign_actions where campaign_id = p.campaign_id and step = p.campaign_step + 1;

  if nxt.step is null then
    if p.campaign_step > 0 and (prev.action_type <> 'connect' or p.stage = 'accepted') then
      update outreach.prospects set stage = 'completed', closed_at = now() where id = p_id and stage <> 'completed';
    end if;
    return null;
  end if;

  if nxt.action_type in ('message','inmail') and prev.action_type = 'connect' then
    if p.stage <> 'accepted' then return null; end if;
    base := coalesce(p.accepted_at, now());
  elsif p.campaign_step = 0 then
    base := coalesce(p.enrolled_at, now());
  else
    base := coalesce(p.last_action_at, now());
  end if;

  fn := coalesce(nullif(p.first_name, ''), split_part(coalesce(p.full_name, ''), ' ', 1));
  msg := replace(replace(coalesce(nxt.text, ''), '_FN_', coalesce(fn, '')), '_LN_', coalesce(p.last_name, ''));

  insert into outreach.action_queue(prospect_id, campaign_id, action, step, message_text, subject, due_at, status)
  values (p_id, p.campaign_id, nxt.action_type, nxt.step, nullif(msg, ''), nxt.subject, base + nxt.delay, 'scheduled')
  on conflict do nothing
  returning id into q_id;
  return q_id;
end $function$;

create or replace function outreach.prospect_before()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare tag text;
begin
  if new.stage = 'approved' and (tg_op = 'INSERT' or old.stage is distinct from 'approved') then
    new.enrolled_at := coalesce(new.enrolled_at, now());
    new.campaign_step := 0;
  end if;
  tag := case new.stage
    when 'approved' then 'enrolled' when 'invited' then 'invited' when 'accepted' then 'accepted'
    when 'msg1_sent' then 'followup-1' when 'msg2_sent' then 'followup-2' when 'msg3_sent' then 'followup-3'
    when 'replied' then 'responded' when 'completed' then 'completed' when 'withdrawn' then 'withdrawn' end;
  if tag is not null and new.campaign_id is not null
     and (tg_op = 'INSERT' or old.stage is distinct from new.stage) then
    new.tags := array(select distinct t from unnest(coalesce(new.tags, '{}') || array['🦆-' || new.campaign_id || '-' || tag]) t);
  end if;
  return new;
end $function$;

create or replace function outreach.prospect_after()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' and old.stage is not distinct from new.stage then return null; end if;
  if new.stage in ('approved','accepted') then
    perform outreach.schedule_next(new.id);
  elsif new.stage in ('replied','withdrawn','skipped','blacklisted','already_connected','completed') then
    update outreach.action_queue set status = 'cancelled', error = 'auto: prospect ' || new.stage
    where prospect_id = new.id and status in ('scheduled','proposed','approved')
      and not (action = 'withdraw' and new.stage not in ('replied','already_connected','blacklisted','completed'));
  end if;
  return null;
end $function$;

create or replace function outreach.queue_after()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare k int; t timestamptz;
begin
  if new.status <> 'done' or old.status = 'done' then return null; end if;
  t := coalesce(new.executed_at, now());
  if new.action = 'reply' then
    update outreach.prospects set reply_answered_at = t, last_action_at = t where id = new.prospect_id;
    return null;
  elsif new.action = 'connect' then
    update outreach.prospects set stage = 'invited', invited_at = t, last_action_at = t,
      campaign_step = greatest(campaign_step, coalesce(new.step, campaign_step))
    where id = new.prospect_id;
  elsif new.action in ('message','inmail') then
    select count(*) into k from outreach.campaign_actions
      where campaign_id = new.campaign_id and step <= new.step and action_type in ('message','inmail');
    update outreach.prospects set
      stage = case when stage in ('replied','blacklisted') then stage
                   when k <= 1 then 'msg1_sent' when k = 2 then 'msg2_sent' else 'msg3_sent' end,
      msg1_at = case when k <= 1 then t else msg1_at end,
      msg2_at = case when k = 2 then t else msg2_at end,
      msg3_at = case when k >= 3 then t else msg3_at end,
      last_action_at = t, campaign_step = greatest(campaign_step, coalesce(new.step, campaign_step))
    where id = new.prospect_id;
  elsif new.action = 'withdraw' then
    update outreach.prospects set stage = 'withdrawn', closed_at = t where id = new.prospect_id;
  elsif new.action = 'visit' then
    update outreach.prospects set visited_at = t,
      last_action_at = case when new.step is not null then t else last_action_at end,
      campaign_step = case when new.step is not null then greatest(campaign_step, new.step) else campaign_step end
    where id = new.prospect_id;
  else
    update outreach.prospects set last_action_at = t, campaign_step = greatest(campaign_step, coalesce(new.step, campaign_step))
    where id = new.prospect_id;
  end if;
  if new.step is not null then perform outreach.schedule_next(new.prospect_id); end if;
  return null;
end $function$;

create or replace function outreach.record_limit_warning(p_note text default null::text)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare lim jsonb; until timestamptz;
begin
  update outreach.settings set value = to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), updated_at = now() where key = 'linkedin_limit_alert';
  lim := outreach.limits(); until := (lim->>'invites_resume_at')::timestamptz;
  insert into outreach.events(event_type, ok, detail) values ('limit_warning', false, jsonb_build_object('note', p_note, 'invites_resume_at', until));
  update outreach.action_queue set status = 'scheduled', due_at = greatest(due_at, until), error = 'waiting: LinkedIn limit warning'
   where action = 'connect' and status in ('scheduled','proposed','approved');
  return jsonb_build_object('invites_resume_at', until);
end $function$;

create or replace function outreach.robot_tick()
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare n_w int := 0; n_h int := 0; n_hold int := 0; r record; lim jsonb := outreach.limits(); until timestamptz;
begin
  insert into outreach.action_queue(prospect_id, campaign_id, action, due_at, status)
  select s.prospect_id, s.campaign_id, 'withdraw', now(), 'scheduled' from outreach.v_stale_invites s
  on conflict do nothing;
  get diagnostics n_w = row_count;
  for r in
    select p.id from outreach.prospects p join outreach.campaigns c on c.id = p.campaign_id and c.status = 'on'
    where p.stage in ('approved','visited','accepted','msg1_sent','msg2_sent','msg3_sent')
      and not exists (select 1 from outreach.action_queue q where q.prospect_id = p.id and q.status in ('scheduled','proposed','approved'))
  loop
    if outreach.schedule_next(r.id) is not null then n_h := n_h + 1; end if;
  end loop;
  -- weekly cap reached: remember the pause so it survives until next Monday
  if lim->>'invite_status' = 'weekly_cap' then
    update outreach.settings set value = to_char((lim->>'invites_resume_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), updated_at = now()
    where key = 'invites_paused_until' and coalesce(nullif(value,'')::timestamptz, '-infinity') < (lim->>'invites_resume_at')::timestamptz;
  end if;
  until := (lim->>'invites_resume_at')::timestamptz;
  if lim->>'invite_status' in ('weekly_cap','linkedin_warning','paused_until') and until is not null then
    update outreach.action_queue set status = 'scheduled', due_at = until,
      error = 'waiting: ' || (lim->>'invite_status') || ' until ' || to_char(until at time zone 'Europe/Berlin', 'DD.MM. HH24:MI')
    where action = 'connect' and status in ('scheduled','proposed') and due_at < until;
    get diagnostics n_hold = row_count;
  end if;
  return jsonb_build_object('withdraw_scheduled', n_w, 'steps_scheduled', n_h, 'invites_held', n_hold, 'limits', lim, 'at', now());
end $function$;

create or replace function outreach.review_reply(p_prospect_id bigint, p_action text, p_outcome text default null::text, p_text text default null::text)
 returns jsonb
 language plpgsql
 set search_path to ''
as $function$
declare q_id bigint;
begin
  if p_action not in ('approve','save','dismiss','answered','outcome') then raise exception 'unknown action %', p_action; end if;
  if p_outcome is not null then
    update outreach.prospects set reply_outcome = p_outcome, reply_reviewed_at = now() where id = p_prospect_id;
  end if;
  if p_action in ('approve','save') then
    if coalesce(trim(p_text), '') = '' then raise exception 'empty reply text'; end if;
    update outreach.action_queue set message_text = p_text,
      status = case when p_action = 'approve' then 'approved' else 'proposed' end,
      approved_at = case when p_action = 'approve' then now() else null end,
      approved_via = case when p_action = 'approve' then 'dashboard' else null end
    where prospect_id = p_prospect_id and action = 'reply' and status in ('scheduled','proposed','approved')
    returning id into q_id;
    if q_id is null then
      insert into outreach.action_queue(prospect_id, campaign_id, action, message_text, due_at, status, approved_at, approved_via)
      select id, campaign_id, 'reply', p_text, now(), case when p_action = 'approve' then 'approved' else 'proposed' end,
             case when p_action = 'approve' then now() end, case when p_action = 'approve' then 'dashboard' end
      from outreach.prospects where id = p_prospect_id returning id into q_id;
    end if;
  elsif p_action = 'dismiss' then
    update outreach.action_queue set status = 'cancelled', error = 'dismissed in dashboard'
    where prospect_id = p_prospect_id and action = 'reply' and status in ('scheduled','proposed','approved');
    update outreach.prospects set reply_priority = 3, reply_reviewed_at = now() where id = p_prospect_id;
  elsif p_action = 'answered' then
    update outreach.action_queue set status = 'cancelled', error = 'answered manually on LinkedIn'
    where prospect_id = p_prospect_id and action = 'reply' and status in ('scheduled','proposed','approved');
    update outreach.prospects set reply_answered_at = now(), reply_reviewed_at = now() where id = p_prospect_id;
  end if;
  return jsonb_build_object('ok', true, 'queue_id', q_id);
end $function$;

create or replace function outreach.dashboard_base()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
select jsonb_build_object(
  'generated_at', now(),
  'settings', (select jsonb_object_agg(key, value) from outreach.settings
               where key in ('paused','linkedin_limit_alert','daily_invite_cap','weekly_invite_cap','daily_message_cap','pending_invite_cap','withdraw_after_days')),
  'usage', (select to_jsonb(u) from outreach.v_today_usage u),
  'routines', (select coalesce(jsonb_agg(jsonb_build_object(
      'kind', r.kind, 'name', r.name, 'cron_utc', r.cron_utc, 'schedule', r.schedule_label, 'description', r.description,
      'last', (select jsonb_build_object('started_at', x.started_at, 'finished_at', x.finished_at, 'status', x.status, 'summary', x.summary, 'notes', x.notes)
               from outreach.runs x where x.kind = r.kind order by x.started_at desc limit 1),
      'runs_7d', (select count(*) from outreach.runs x where x.kind = r.kind and x.started_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from outreach.runs x where x.kind = r.kind and x.started_at > now() - interval '7 days' and x.status in ('failed','aborted','partial'))
    ) order by r.sort), '[]'::jsonb) from outreach.routines r),
  'runs', (select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb) from
            (select id, kind, started_at, finished_at, status, summary, left(notes, 300) notes from outreach.runs order by started_at desc limit 40) x),
  'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status,
       'steps', (select count(*) from outreach.campaign_actions a where a.campaign_id = c.id),
       'stats', (select to_jsonb(s) from outreach.v_campaign_stats s where s.campaign_id = c.id),
       'stages', (select jsonb_object_agg(stage, n) from (select stage, count(*) n from outreach.prospects p where p.campaign_id = c.id group by stage) z)
     ) order by case c.status when 'on' then 0 when 'off' then 1 else 2 end, c.id), '[]'::jsonb) from outreach.campaigns c),
  'totals', (select to_jsonb(t) from (select
      count(*) filter (where invited_at is not null or stage in ('invited','accepted','msg1_sent','msg2_sent','msg3_sent','replied','completed','withdrawn')) invited,
      count(*) filter (where accepted_at is not null or stage in ('accepted','msg1_sent','msg2_sent','msg3_sent','completed') or (stage='replied' and coalesce(raw::text,'') like '%-accepted%')) accepted,
      count(*) filter (where replied_at is not null or stage = 'replied') replied,
      count(*) filter (where msg1_at is not null or stage in ('msg1_sent','msg2_sent','msg3_sent')) messaged,
      count(*) prospects,
      count(*) filter (where stage in ('approved','visited')) enrolled_waiting
    from outreach.prospects) t),
  'baseline', (select data from outreach.legacy_snapshots where kind = 'kpi' and key = '*'),
  'weekly', (select coalesce(jsonb_agg(to_jsonb(w) order by w.week), '[]'::jsonb) from
      (select date_trunc('week', occurred_at at time zone 'Europe/Berlin')::date week,
         count(*) filter (where event_type = 'invite_sent' and ok) invites,
         count(*) filter (where event_type = 'accepted') accepted,
         count(*) filter (where event_type = 'message_sent' and ok) messages,
         count(*) filter (where event_type = 'reply_detected') replies,
         count(*) filter (where event_type = 'visit' and ok) visits,
         count(*) filter (where not ok) errors
       from outreach.events where occurred_at > now() - interval '12 weeks' group by 1) w),
  'daily', (select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb) from
      (select (occurred_at at time zone 'Europe/Berlin')::date as day,
         count(*) filter (where action_type = 'connectProfile' and success) invites,
         count(*) filter (where action_type = 'messageProfile' and success) messages,
         count(*) filter (where not success) errors
       from outreach.legacy_actions where occurred_at > now() - interval '60 days' group by 1) d),
  'queue', jsonb_build_object(
      'by_status', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select status || ':' || action k, count(*) n from outreach.action_queue where status in ('scheduled','proposed','approved') group by 1) z),
      'due_now', (select count(*) from outreach.v_robot_due),
      'upcoming', (select coalesce(jsonb_agg(to_jsonb(u) order by u.due_at), '[]'::jsonb) from
          (select q.id, q.action, q.step, q.status, q.due_at, q.campaign_id, p.full_name, p.company
           from outreach.action_queue q join outreach.prospects p on p.id = q.prospect_id
           where q.status in ('scheduled','proposed','approved') order by q.due_at limit 30) u)),
  'replies', (select coalesce(jsonb_agg(to_jsonb(r) order by r.replied_at desc nulls last), '[]'::jsonb) from
      (select id, full_name, company, headline, campaign_id, replied_at, left(reply_snippet, 240) snippet, linkedin_url
       from outreach.prospects where stage = 'replied' and (replied_at > now() - interval '60 days' or replied_at is null and campaign_id = 'ki-agenten-makler')
       order by replied_at desc nulls last limit 25) r),
  'activity', (select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at desc), '[]'::jsonb) from
      (select e.occurred_at, e.event_type, e.step, e.ok, e.campaign_id, p.full_name, left(coalesce(e.detail->>'error', e.detail->>'note', ''), 160) note
       from outreach.events e left join outreach.prospects p on p.id = e.prospect_id
       where e.event_type <> 'imported' order by e.occurred_at desc limit 40) e)
);
$function$;

create or replace function outreach.dashboard_daily()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb) from (
  select day, sum(invites)::int invites, sum(messages)::int messages, sum(accepted)::int accepted, sum(replies)::int replies, sum(errors)::int errors from (
    select (occurred_at at time zone 'Europe/Berlin')::date as day,
      count(*) filter (where action_type = 'connectProfile' and success) invites,
      count(*) filter (where action_type = 'messageProfile' and success) messages,
      0 accepted, 0 replies,
      count(*) filter (where not success and action_type in ('connectProfile','messageProfile')) errors
    from outreach.legacy_actions where occurred_at > now() - interval '60 days' group by 1
    union all
    select (occurred_at at time zone 'Europe/Berlin')::date,
      count(*) filter (where event_type = 'invite_sent' and ok and coalesce(detail->>'source','') <> 'legacy-import'),
      count(*) filter (where event_type = 'message_sent' and ok and coalesce(detail->>'source','') <> 'legacy-import'),
      count(*) filter (where event_type = 'accepted'),
      count(*) filter (where event_type = 'reply_detected'),
      count(*) filter (where not ok)
    from outreach.events where occurred_at > now() - interval '60 days' group by 1
  ) u group by day) d;
$function$;

create or replace function outreach.dashboard_inbox()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
select coalesce(jsonb_agg(to_jsonb(x) order by x.sortkey, x.replied_at desc nulls last), '[]'::jsonb) from (
  select p.id, p.full_name, p.company, p.headline, p.campaign_id, p.linkedin_url, p.replied_at, p.reply_snippet as snippet,
    p.reply_outcome as outcome, p.reply_priority as priority, p.reply_reason as reason, p.reply_answered_at as answered_at,
    q.id as queue_id, q.status as draft_status, q.message_text as draft, q.approved_via, q.executed_at as sent_at,
    case when q.status = 'done' or p.reply_answered_at is not null then 5 else coalesce(p.reply_priority, 4) end as sortkey
  from outreach.prospects p
  left join lateral (select * from outreach.action_queue a where a.prospect_id = p.id and a.action = 'reply'
                     order by case when a.status in ('proposed','approved') then 0 else 1 end, a.id desc limit 1) q on true
  where p.stage = 'replied' or p.reply_outcome is not null
) x;
$function$;

create or replace function outreach.dashboard_runs()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb) from
 (select id, kind, started_at, finished_at, status, summary - 'kpis_all_time' as summary, left(notes, 1500) notes,
         extract(epoch from (finished_at - started_at))::int as seconds
  from outreach.runs order by started_at desc limit 150) x;
$function$;

create or replace function outreach.dashboard()
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
select outreach.dashboard_base() || jsonb_build_object('daily', outreach.dashboard_daily(), 'inbox', outreach.dashboard_inbox(), 'limits', outreach.limits(), 'runs', outreach.dashboard_runs());
$function$;

-- Triggers ----------------------------------------------------------------------------------------
create trigger campaigns_touch before update on outreach.campaigns for each row execute function outreach.touch_updated_at();
create trigger prospect_after after insert or update of stage on outreach.prospects for each row execute function outreach.prospect_after();
create trigger prospect_before before insert or update of stage on outreach.prospects for each row execute function outreach.prospect_before();
create trigger prospects_touch before update on outreach.prospects for each row execute function outreach.touch_updated_at();
create trigger queue_after after update of status on outreach.action_queue for each row execute function outreach.queue_after();

-- Comments ----------------------------------------------------------------------------------------
comment on table outreach.settings is 'Global limits and switches for the outreach robot. Edit values here to change behaviour.';
comment on table outreach.campaigns is 'Sequence copy. _FN_ in any text is replaced by the prospect''s first name. msg1 goes msg1_delay_hours after acceptance, msg2 msg2_delay_days after msg1, msg3 msg3_delay_days after msg2. Any reply stops the sequence.';
comment on table outreach.prospects is 'One row per LinkedIn person. linkedin_url is normalised to https://www.linkedin.com/in/<slug>/ . stage is the current funnel stage; the *_at columns keep when each step happened.';
comment on table outreach.runs is 'One row per skill run (prepare, send, check, report, import).';
comment on table outreach.action_queue is 'The robot queue. The prepare run adds rows as proposed; Jibran approves; the send step executes approved rows and marks them done/failed.';
comment on table outreach.events is 'Append-only log of everything the robot did or observed. KPIs are computed from here and from prospects.';
comment on table outreach.messages is 'LinkedIn conversation history per prospect. INVITATION_ACCEPT rows mark acceptances; MEMBER_TO_MEMBER are real messages.';
comment on table outreach.campaign_actions is 'Drip sequence. delay = wait before this action, counted from the previous action (from acceptance when the previous action was connect, from enrolment for step 1). _FN_ / _LN_ are replaced with first/last name.';
comment on table outreach.routines is 'The scheduled Claude tasks that act on LinkedIn. runs.kind links each run to its routine. Keep cron_utc in sync with the scheduled task.';
comment on table outreach.docs is 'Versioned plain-text documents for the outreach routines (e.g. targeting_rules). Append-only: every edit is a new version. Read the current one with outreach.doc(key); write with outreach.doc_put(key, content, note).';
comment on table outreach.candidates is 'Every candidate seen by a prospecting round, including rejects and their reason. One row per candidate per run.';
comment on table outreach.legacy_contacts is 'Verbatim copy of the address book imported from the previous tool, last 12 months. Source archive; outreach.prospects is the working table.';
comment on table outreach.legacy_actions is 'Verbatim action log imported from the previous tool, last 12 months.';
comment on table outreach.legacy_queue is 'Snapshot of the previous tool''s command queue, taken when it was paused on 21.09.2026. These commands were NOT executed.';
comment on table outreach.legacy_snapshots is 'Settings of the previous tool (kind=settings) and KPI snapshots (kind=kpi, key=campaign id, * = all).';

-- migrate:down
-- The baseline is never rolled back on a database that holds data.
select 1;
