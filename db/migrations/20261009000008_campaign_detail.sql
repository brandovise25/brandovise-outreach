-- migrate:up
-- What is inside a campaign: its steps (action, delay, text) and where its people are.
create or replace function public.ext_campaign_detail(p_user_id uuid, p_campaign_id text)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare
  c outreach.campaigns;
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into c from outreach.campaigns where id = p_campaign_id;
  if not found then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', c.id, 'name', c.name, 'status', c.status, 'description', c.description, 'language', c.language,
    'target_group', outreach.ext_target_group(c.id),
    'steps', (select coalesce(jsonb_agg(jsonb_build_object(
                'step', a.step, 'action', a.action_type, 'text', a.text, 'subject', a.subject,
                'delay_hours', round(extract(epoch from a.delay) / 3600)) order by a.step), '[]')
              from outreach.campaign_actions a where a.campaign_id = c.id),
    'stages', (select coalesce(jsonb_object_agg(stage, n), '{}')
               from (select stage, count(*) n from outreach.prospects where campaign_id = c.id group by stage) s),
    'queue', (select coalesce(jsonb_object_agg(k, n), '{}')
              from (select status || ':' || action k, count(*) n from outreach.action_queue
                    where campaign_id = c.id and status in ('scheduled', 'proposed', 'approved') group by 1) q));
end $$;

revoke all on function public.ext_campaign_detail(uuid, text) from public;
grant execute on function public.ext_campaign_detail(uuid, text) to api_rpc;

-- migrate:down
drop function if exists public.ext_campaign_detail(uuid, text);
