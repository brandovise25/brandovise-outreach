-- migrate:up
-- Robot health for the MCP server (Jibran, 05.11.2026): Claude must see the extension's side (last
-- check-in, last error, when it last asked for a job) and the settings that hold jobs back, without
-- asking Jibran to look at the side panel. Additive only.

alter table outreach.ext_devices add column if not exists last_claim_at timestamptz;

-- Called by POST /ext/jobs/claim: the extension asked for work (whether or not it got a job).
create or replace function public.ext_device_claimed(p_user_id uuid, p_device_id uuid)
returns void
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  update outreach.ext_devices set last_claim_at = now() where device_id = p_device_id;
end $$;

create or replace function public.ext_mcp_health(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  v_hour int := extract(hour from now() at time zone 'Europe/Berlin');
  v_hours jsonb := coalesce(outreach.ext_setting('job_hours'), '{"from": 7, "to": 21}');
  v_next timestamptz := nullif(outreach.ext_setting('job_next_after') #>> '{}', '')::timestamptz;
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'now', now(),
    'berlin_hour', v_hour,
    'devices', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', d.name, 'version', d.version, 'last_seen', d.last_seen,
                  'last_claim_at', d.last_claim_at, 'last_error', d.last_error) order by d.last_seen desc), '[]')
                from outreach.ext_devices d where d.user_id = p_user_id),
    'jobs_held_back_because', case
      when exists (select 1 from outreach.ext_jobs where status = 'running') then 'another job is running'
      when v_next > now() then 'pause between jobs until ' || v_next
      when v_hour < coalesce((v_hours->>'from')::int, 7) or v_hour >= coalesce((v_hours->>'to')::int, 21)
        then 'outside robot hours ' || v_hours::text
      else null end,
    'queued', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'not_before', not_before,
                 'created_by', created_by) order by not_before), '[]')
               from outreach.ext_jobs where status = 'queued'),
    'running', (select to_jsonb(j) from (select id, kind, started_at from outreach.ext_jobs
                where status = 'running' limit 1) j),
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from outreach.settings
                 where key in ('job_hours', 'job_gap_seconds', 'job_next_after', 'ext_dry_run', 'ext_min_version',
                               'comment_autopost', 'comment_posting_live', 'auto_approve', 'daily_invite_cap',
                               'weekly_invite_cap', 'daily_message_cap', 'pending_invite_cap'))
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_device_claimed(uuid,uuid)', 'ext_mcp_health(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_mcp_health(uuid);
drop function if exists public.ext_device_claimed(uuid, uuid);
alter table outreach.ext_devices drop column if exists last_claim_at;
