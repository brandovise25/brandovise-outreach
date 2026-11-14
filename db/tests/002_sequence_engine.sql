-- Drives the sequence engine (triggers + schedule_next) copied from Supabase, inside a transaction
-- that is rolled back. Proves the baseline behaves like production: stage changes and queue rows
-- marked done create the next steps; a reply cancels everything open.
\set ON_ERROR_STOP on
begin;

do $$
declare
  pid bigint;
  q record;
  n int;
begin
  insert into outreach.campaigns (id, name, status) values ('t-camp', 'Test', 'on');
  insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay) values
    ('t-camp', 1, 'connect', 'Hallo _FN_', '4 hours'),
    ('t-camp', 2, 'message', 'Danke _FN_ fuer die Vernetzung', '4 hours'),
    ('t-camp', 3, 'message', 'Follow-up _FN_', '7 days');

  insert into outreach.prospects (linkedin_url, first_name, campaign_id, stage)
  values ('https://www.linkedin.com/in/t-test/', 'Anna', 't-camp', 'approved') returning id into pid;

  -- approved -> step 1 connect scheduled, enrolment tag set
  select * into q from outreach.action_queue where prospect_id = pid;
  if q.action <> 'connect' or q.step <> 1 or q.status <> 'scheduled' or q.message_text <> 'Hallo Anna' then
    raise exception 'step 1 not queued correctly: %', row_to_json(q);
  end if;
  if not exists (select 1 from outreach.prospects where id = pid and '🦆-t-camp-enrolled' = any(tags)) then
    raise exception 'enrolment tag missing';
  end if;

  -- connect done -> invited, nothing new until acceptance
  update outreach.action_queue set status = 'done', executed_at = now() where id = q.id;
  if (select stage from outreach.prospects where id = pid) <> 'invited' then raise exception 'not invited'; end if;
  select count(*) into n from outreach.action_queue where prospect_id = pid and status = 'scheduled';
  if n <> 0 then raise exception 'message queued before acceptance'; end if;

  -- accepted -> step 2 message at accepted_at + 4h
  update outreach.prospects set stage = 'accepted', accepted_at = now() - interval '1 hour' where id = pid;
  select * into q from outreach.action_queue where prospect_id = pid and status = 'scheduled';
  if q.step <> 2 or q.action <> 'message' or abs(extract(epoch from q.due_at - (now() + interval '3 hours'))) > 5 then
    raise exception 'step 2 not queued correctly: %', row_to_json(q);
  end if;

  -- message done -> msg1_sent and step 3 scheduled
  update outreach.action_queue set status = 'done', executed_at = now() where id = q.id;
  if (select stage from outreach.prospects where id = pid) <> 'msg1_sent' then raise exception 'not msg1_sent'; end if;
  select * into q from outreach.action_queue where prospect_id = pid and status = 'scheduled';
  if q.step <> 3 then raise exception 'step 3 not queued'; end if;

  -- reply -> open rows cancelled
  update outreach.prospects set stage = 'replied', replied_at = now() where id = pid;
  select count(*) into n from outreach.action_queue where prospect_id = pid and status in ('scheduled','proposed','approved');
  if n <> 0 then raise exception 'reply did not cancel open rows'; end if;

  -- limits() and robot_tick() run against the copied schema
  if outreach.limits()->>'invite_status' is null then raise exception 'limits() broken'; end if;
  if outreach.robot_tick()->'limits' is null then raise exception 'robot_tick() broken'; end if;

  -- linkedin_url normaliser
  if outreach.norm_li_url('https://www.linkedin.com/in/m%C3%BCller-x/?trk=1') <> 'https://www.linkedin.com/in/müller-x/' then
    raise exception 'norm_li_url broken';
  end if;

  raise notice '002_sequence_engine: all checks passed';
end $$;

rollback;
