-- migrate:up
-- Keyword editor per campaign: how each prospecting keyword has done so far.
create or replace function public.ext_keyword_stats(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_object_agg(keyword, jsonb_build_object(
            'looked_at', n, 'approved', a, 'staged', s, 'last_used', last_used)), '{}')
          from (select keyword, count(*) n, count(*) filter (where verdict = 'approved') a,
                       count(*) filter (where verdict = 'staged') s, max(found_at) last_used
                from outreach.candidates where keyword is not null group by keyword) x);
end $$;
revoke all on function public.ext_keyword_stats(uuid) from public;
grant execute on function public.ext_keyword_stats(uuid) to api_rpc;

-- migrate:down
drop function if exists public.ext_keyword_stats(uuid);
