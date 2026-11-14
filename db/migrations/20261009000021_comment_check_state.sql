-- migrate:up
-- A live post where the button was pressed but the comment was not seen afterwards must never be
-- posted again by accident (09.10.2026, #32: "Pressed the button, but the comment did not appear").
-- Such drafts go to status 'check': no Post button, no auto-post, no queued post, until Jibran says
-- "Mark as posted" or "Not posted - back to approved".

alter table outreach.engagement drop constraint if exists engagement_status_check;
alter table outreach.engagement add constraint engagement_status_check
  check (status in ('drafted', 'approved', 'check', 'posted', 'rejected', 'skipped'));

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
    posted_url = coalesce(nullif(p_result->>'postedUrl', ''), posted_url)
  where id = p_id;
  if not found then raise exception 'unknown comment draft' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'posted', v_posted, 'check', v_unsure);
end $$;

create or replace function public.ext_list_comments(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return (select coalesce(jsonb_agg(to_jsonb(e) order by e.status, e.created_at desc), '[]') from (
    select id, created_at, post_url, post_excerpt, post_age, author_name, author_headline, author_profile,
           comment_draft, reason, status, reviewed_at, verified, posted_url, posted_at,
           post_log->-1 as last_attempt
    from outreach.engagement
    where status in ('drafted', 'approved', 'check') or (status = 'posted' and posted_at > now() - interval '3 days')
    order by created_at desc limit 100) e);
end $$;

-- Drafts already pressed live without confirmation (e.g. #32) move to 'check'.
update outreach.engagement e set status = 'check'
where e.status = 'approved' and exists (
  select 1 from jsonb_array_elements(e.post_log) a
  where coalesce((a->>'clicked')::boolean, false) and not coalesce((a->>'dryRun')::boolean, true)
    and not coalesce((a->>'verified')::boolean, false));

-- migrate:down
update outreach.engagement set status = 'approved' where status = 'check';
alter table outreach.engagement drop constraint if exists engagement_status_check;
alter table outreach.engagement add constraint engagement_status_check
  check (status in ('drafted', 'approved', 'posted', 'rejected', 'skipped'));
