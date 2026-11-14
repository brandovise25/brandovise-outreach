-- migrate:up
-- Save the link of a post the robot found on the author's page, so later attempts open it directly.

create or replace function public.ext_comment_result(p_user_id uuid, p_id bigint, p_result jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  v_live boolean := not coalesce((p_result->>'dryRun')::boolean, true);
  v_posted boolean := v_live and coalesce((p_result->>'verified')::boolean, false);
  v_unsure boolean := v_live and not v_posted and coalesce((p_result->>'clicked')::boolean, false);
begin
  perform outreach.ext_assert_user(p_user_id);
  update outreach.engagement set
    post_log = post_log || jsonb_build_array(p_result || jsonb_build_object('at', now())),
    status = case when v_posted then 'posted' when v_unsure then 'check' else status end,
    verified = verified or v_posted,
    posted_at = case when v_posted then now() else posted_at end,
    posted_url = coalesce(nullif(p_result->>'postedUrl', ''), posted_url),
    -- the post's own link, found by the robot on the page: next time it opens the post directly
    post_url = coalesce(post_url, case when p_result->>'postLink' ~ '^https://www\.linkedin\.com/feed/update/urn:li:activity:[0-9]+/$'
                                       then p_result->>'postLink' end)
  where id = p_id;
  if not found then raise exception 'unknown comment draft' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'posted', v_posted, 'check', v_unsure);
end $$;

-- migrate:down
-- (previous definition in 20261009000021_comment_check_state.sql)
