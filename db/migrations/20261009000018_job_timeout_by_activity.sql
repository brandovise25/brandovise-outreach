-- migrate:up
-- Jobs time out after 20 minutes without a log line, not 20 minutes after their start.

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
  -- A running job that has logged nothing for 20 minutes is dead (long read-through jobs log every step).
  update outreach.ext_jobs j set status = 'error', finished_at = now(), result = jsonb_build_object('message', 'timed out')
  where j.status = 'running'
    and greatest(j.started_at, (select max(e.at) from outreach.ext_job_events e where e.job_id = j.id))
        < now() - interval '20 minutes';
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


-- migrate:down
-- (previous definition in 20261009000017_job_gaps.sql)
