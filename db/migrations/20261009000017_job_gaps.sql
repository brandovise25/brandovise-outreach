-- migrate:up
-- Long, irregular pauses between robot jobs (Jibran, 09.10.2026): after each LinkedIn job the next one
-- waits a random 3-10 minutes (settings.job_gap_seconds). Pacing stays well under LinkedIn's limits.

insert into outreach.settings (key, value, note)
values ('job_gap_seconds', '{"min": 180, "max": 600}', 'random pause between two robot jobs')
on conflict (key) do nothing;

create or replace function public.ext_job_claim(p_user_id uuid, p_device_id uuid)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  j outreach.ext_jobs;
  v_next timestamptz := nullif(outreach.ext_setting('comment_autopost_next') #>> '{}', '')::timestamptz;
  v_hour int := extract(hour from now() at time zone 'Europe/Berlin');
  v_today int;
  v_cand bigint;
begin
  perform outreach.ext_assert_user(p_user_id);
  update outreach.ext_jobs set status = 'error', finished_at = now(), result = jsonb_build_object('message', 'timed out')
  where status = 'running' and started_at < now() - interval '20 minutes';
  -- The extension runs one job at a time and only asks for the next one when it is idle. A job still
  -- 'running' on the asking device was cut off (extension reloaded, browser closed).
  with cut as (
    update outreach.ext_jobs set status = 'error', finished_at = now(),
           result = jsonb_build_object('message', 'Interrupted: the extension was restarted.')
    where status = 'running' and device_id = p_device_id
    returning id)
  insert into outreach.ext_job_events (job_id, level, step, message)
  select id, 'error', 'finish', 'Interrupted: the extension was restarted.' from cut;
  if exists (select 1 from outreach.ext_jobs where status = 'running') then
    return null;
  end if;
  -- A long, irregular pause between two LinkedIn jobs (set when the last one finished).
  if nullif(outreach.ext_setting('job_next_after') #>> '{}', '')::timestamptz > now() then
    return null;
  end if;

  -- Auto-post planner: live mode + auto-post on, 07-21 Berlin, under the daily cap, gap elapsed.
  if not exists (select 1 from outreach.ext_jobs where status = 'queued' and not_before <= now())
     and outreach.ext_setting('comment_autopost') = 'true'::jsonb
     and outreach.ext_setting('comment_posting_live') = 'true'::jsonb
     and v_hour >= 7 and v_hour < 21
     and (v_next is null or v_next <= now()) then
    select count(*) into v_today from outreach.ext_jobs
      where kind = 'post_comment' and created_by = 'autopost'
        and created_at >= date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin';
    if v_today < coalesce((outreach.ext_setting('comment_autopost_daily_max') #>> '{}')::int, 5) then
      select e.id into v_cand from outreach.engagement e
      where e.status = 'approved'
        and not exists (select 1 from outreach.ext_jobs x where x.kind = 'post_comment'
                        and (x.params->>'id')::bigint = e.id and x.status in ('queued', 'running', 'done'))
      order by e.reviewed_at nulls last, e.id limit 1;
      if v_cand is not null then
        insert into outreach.ext_jobs (kind, params, created_by) values ('post_comment', jsonb_build_object('id', v_cand), 'autopost');
        -- Next auto-post 30-90 minutes later.
        insert into outreach.settings (key, value, note)
        values ('comment_autopost_next', to_jsonb(now() + make_interval(mins => 30 + floor(random() * 61)::int))::text, 'set by the auto-post planner')
        on conflict (key) do update set value = excluded.value, updated_at = now();
      end if;
    end if;
  end if;

  select * into j from outreach.ext_jobs where status = 'queued' and not_before <= now()
  order by not_before, id limit 1 for update skip locked;
  if not found then return null; end if;
  update outreach.ext_jobs set status = 'running', started_at = now(), device_id = p_device_id where id = j.id;
  return jsonb_build_object('id', j.id, 'kind', j.kind, 'params', j.params, 'created_by', j.created_by);
end $$;


-- The finish call may now also report 'stopped'.
create or replace function public.ext_job_finish(p_user_id uuid, p_id bigint, p_status text, p_result jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_status not in ('done', 'error', 'stopped') then
    raise exception 'status must be done, error or stopped' using errcode = '22023';
  end if;
  update outreach.ext_jobs set status = p_status, finished_at = now(), result = p_result where id = p_id and status = 'running';
  if found then
    -- Next LinkedIn job no earlier than a random gap from now (settings.job_gap_seconds).
    insert into outreach.settings (key, value, note)
    values ('job_next_after', to_jsonb(now() + make_interval(secs =>
              coalesce((outreach.ext_setting('job_gap_seconds')->>'min')::int, 180)
              + floor(random() * (1 + greatest(0,
                  coalesce((outreach.ext_setting('job_gap_seconds')->>'max')::int, 600)
                  - coalesce((outreach.ext_setting('job_gap_seconds')->>'min')::int, 180))))))::text,
            'set when a robot job finishes')
    on conflict (key) do update set value = excluded.value, updated_at = now();
    insert into outreach.ext_job_events (job_id, level, step, message)
    values (p_id, case p_status when 'error' then 'error' when 'stopped' then 'warn' else 'info' end, 'finish',
            left(coalesce(p_result->>'message', p_status), 1000));
  end if;
  -- Old log lines go after 30 days.
  delete from outreach.ext_job_events where at < now() - interval '30 days';
  return jsonb_build_object('ok', found);
end $$;


-- The robot bar: the running job with its progress and latest lines, what is queued, the last result.
create or replace function public.ext_robot(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  r outreach.ext_jobs;
  l outreach.ext_jobs;
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into r from outreach.ext_jobs where status = 'running' order by started_at desc limit 1;
  select * into l from outreach.ext_jobs where status in ('done', 'error', 'stopped') order by finished_at desc nulls last limit 1;
  return jsonb_build_object(
    'now', now(),
    'next_after', outreach.ext_setting('job_next_after') #>> '{}',
    'running', case when r.id is null then null else jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'params', r.params, 'created_by', r.created_by, 'started_at', r.started_at,
      'progress', r.progress, 'stop_requested', r.stop_requested,
      'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.id desc), '[]') from
                  (select id, at, level, step, message from outreach.ext_job_events where job_id = r.id order by id desc limit 6) e)) end,
    'queued', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'not_before', not_before, 'created_by', created_by) order by not_before, id), '[]')
               from (select * from outreach.ext_jobs where status = 'queued' order by not_before, id limit 10) q),
    'last', case when l.id is null then null else jsonb_build_object(
      'id', l.id, 'kind', l.kind, 'status', l.status, 'finished_at', l.finished_at, 'result', l.result) end);
end $$;


-- migrate:down
delete from outreach.settings where key in ('job_gap_seconds', 'job_next_after');
