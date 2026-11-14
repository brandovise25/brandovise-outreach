-- migrate:up
-- Authors Jibran commented on in the last p_days days, or who still have an open draft: their new posts
-- are skipped by the comment round without an AI call (Jibran, 21.10.2026: one comment per person per week).
create or replace function public.ext_engagement_paused_authors(p_user_id uuid, p_days int)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'name', author_name, 'profile', author_profile, 'status', status,
            'at', coalesce(posted_at, created_at))), '[]')
          from outreach.engagement
          where (status = 'posted' and coalesce(posted_at, created_at) > now() - make_interval(days => greatest(p_days, 0)))
             or status in ('drafted', 'approved', 'check', 'blocked'));
end $$;

do $$
begin
  revoke all on function public.ext_engagement_paused_authors(uuid,int) from public;
  grant execute on function public.ext_engagement_paused_authors(uuid,int) to api_rpc;
end $$;

-- migrate:down
drop function if exists public.ext_engagement_paused_authors(uuid,int);
