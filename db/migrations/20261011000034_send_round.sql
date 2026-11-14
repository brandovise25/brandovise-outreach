-- migrate:up
-- Send round. Practice first: while settings.ext_dry_run is true, every item is opened, typed and read
-- back, then cancelled; nothing is sent and the queue row stays as it is (only an event is logged).
-- Live sends (later, after the cutover) mark the row done; the triggers move the prospect on, and the
-- invite_sent / message_sent events feed outreach.limits().
-- Checks before handing out items: robot not paused, inside the send window (robot_schedule, Berlin),
-- limits() allow it, the item is approved, due, and not older than 14 days (older ones need a new
-- approval, so nothing stale goes out), and the prospect has not replied in the meantime.

alter table outreach.events drop constraint if exists events_event_type_check;
alter table outreach.events add constraint events_event_type_check check (event_type = any (array[
  'found', 'visit', 'invite_sent', 'invite_withdrawn', 'accepted', 'message_sent', 'reply_detected',
  'skipped', 'error', 'stage_change', 'imported', 'limit_warning', 'sync', 'send_practice', 'send_failed']));

create or replace function outreach.send_window_open(p_at timestamptz default now())
returns boolean
language plpgsql stable
set search_path = outreach, public
as $$
declare
  s jsonb := outreach.ext_setting('robot_schedule');
  local timestamp := p_at at time zone 'Europe/Berlin';
  wins jsonb := s -> extract(dow from local)::int::text;
  w jsonb;
  hm text := to_char(local, 'HH24:MI');
begin
  if s is null then return true; end if;
  for w in select * from jsonb_array_elements(coalesce(wins, '[]')) loop
    if hm >= (w->>0) and hm < (w->>1) then return true; end if;
  end loop;
  return false;
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
  items jsonb;
  stale int;
begin
  perform outreach.ext_assert_user(p_user_id);
  -- Practice sends nothing, so up to 3 of each may be practised even when the limits are reached.
  if practice then
    msg_left := greatest(msg_left, 3);
    inv_left := greatest(inv_left, 3);
  end if;
  select count(*) into stale from outreach.action_queue
   where status = 'approved' and due_at < now() - interval '14 days';
  if paused or not outreach.send_window_open() then
    return jsonb_build_object('items', '[]'::jsonb, 'practice', practice, 'paused', paused,
      'window_open', outreach.send_window_open(), 'stale', stale, 'limits', lim);
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
                            'stale', stale, 'limits', lim);
end $$;

create or replace function public.ext_send_result(p_user_id uuid, p_queue_id bigint, p_practice boolean, p_ok boolean, p_note text, p_detail jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  q outreach.action_queue;
  dry boolean := coalesce(outreach.ext_setting('ext_dry_run') <> 'false'::jsonb, true);
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into q from outreach.action_queue where id = p_queue_id for update;
  if not found then raise exception 'unknown queue row' using errcode = 'P0002'; end if;
  if p_practice then
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values ('send_practice', p_ok, q.prospect_id, jsonb_build_object('queue_id', q.id, 'action', q.action, 'note', left(p_note, 500)) || coalesce(p_detail, '{}'));
    return jsonb_build_object('ok', true, 'practice', true);
  end if;
  if dry then raise exception 'dry run is on: live results are not accepted' using errcode = '22023'; end if;
  if q.status <> 'approved' then raise exception 'row is %, not approved', q.status using errcode = '22023'; end if;
  if p_ok then
    update outreach.action_queue set status = 'done', executed_at = now() where id = q.id;
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values (case q.action when 'connect' then 'invite_sent' when 'withdraw' then 'invite_withdrawn' else 'message_sent' end,
            true, q.prospect_id, jsonb_build_object('queue_id', q.id, 'source', 'extension') || coalesce(p_detail, '{}'));
  else
    update outreach.action_queue set status = 'failed', error = left(p_note, 500) where id = q.id;
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values ('send_failed', false, q.prospect_id, jsonb_build_object('queue_id', q.id, 'action', q.action, 'note', left(p_note, 500)));
  end if;
  return jsonb_build_object('ok', true, 'practice', false);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_send_batch(uuid,int)', 'ext_send_result(uuid,bigint,boolean,boolean,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_send_result(uuid,bigint,boolean,boolean,text,jsonb);
drop function if exists public.ext_send_batch(uuid,int);
drop function if exists outreach.send_window_open(timestamptz);
