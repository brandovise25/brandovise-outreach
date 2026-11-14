-- migrate:up
-- Comments the checks refuse before posting (code rules or the AI fact check) move to status 'blocked'
-- with the reason, instead of staying under Approved (Jibran, 11.10.2026). Editing the text and
-- approving it again puts it back to 'approved'; the check runs again before posting.

alter table outreach.engagement add column if not exists block_reason text;
alter table outreach.engagement drop constraint if exists engagement_status_check;
alter table outreach.engagement add constraint engagement_status_check
  check (status in ('drafted', 'approved', 'check', 'blocked', 'posted', 'rejected', 'skipped'));

create or replace function public.ext_comment_blocked(p_user_id uuid, p_id bigint, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  update outreach.engagement set status = 'blocked', block_reason = left(p_reason, 1000),
         post_log = post_log || jsonb_build_array(jsonb_build_object('at', now(), 'note', 'Blocked by the check: ' || left(p_reason, 500)))
   where id = p_id and status = 'approved';
  return jsonb_build_object('ok', found);
end $$;

-- approving again (after an edit) clears the reason
create or replace function public.ext_review_comment(p_user_id uuid, p_id bigint, p_decision text, p_text text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_decision not in ('approve', 'reject', 'posted', 'save') then
    raise exception 'unknown decision %', p_decision using errcode = '22023';
  end if;
  update outreach.engagement set
    comment_draft = coalesce(p_text, comment_draft),
    status = case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' when 'posted' then 'posted' else status end,
    block_reason = case when p_decision in ('approve', 'reject', 'posted') then null else block_reason end,
    reviewed_at = now(),
    posted_at = case p_decision when 'posted' then now() when 'approve' then null else posted_at end
  where id = p_id;
  if not found then raise exception 'unknown comment draft' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ext_list_comments_filtered(p_user_id uuid, p_filter text)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
declare v_status text[];
begin
  perform outreach.ext_assert_user(p_user_id);
  v_status := case p_filter
    when 'review' then array['drafted']
    when 'approved' then array['approved', 'check']
    when 'blocked' then array['blocked']
    when 'posted' then array['posted']
    when 'rejected' then array['rejected']
    else array['drafted', 'approved', 'check'] end;
  return jsonb_build_object(
    'counts', (select jsonb_build_object(
        'review', count(*) filter (where status = 'drafted'),
        'approved', count(*) filter (where status in ('approved', 'check')),
        'blocked', count(*) filter (where status = 'blocked'),
        'posted', count(*) filter (where status = 'posted'),
        'rejected', count(*) filter (where status = 'rejected'))
      from outreach.engagement),
    'items', (select coalesce(jsonb_agg(to_jsonb(e) order by e.sort_at desc), '[]') from (
      select id, created_at, post_url, post_excerpt, post_age, author_name, author_headline, author_profile,
             comment_draft, reason, status, block_reason, reviewed_at, verified, posted_url, posted_at,
             post_log->-1 as last_attempt, coalesce(posted_at, reviewed_at, created_at) as sort_at
      from outreach.engagement
      where status = any(v_status)
      order by coalesce(posted_at, reviewed_at, created_at) desc limit 200) e));
end $$;

-- Comments refused earlier (last attempt says "Not posted" by a check) move to blocked now.
update outreach.engagement e set status = 'blocked',
       block_reason = left(regexp_replace(j.job_msg, '^Not posted\.\s*', ''), 1000)
from (select distinct on ((params->>'id')::bigint) (params->>'id')::bigint as eid, result->>'message' as job_msg
      from outreach.ext_jobs where kind = 'post_comment' order by (params->>'id')::bigint, id desc) j
where e.id = j.eid and e.status = 'approved' and j.job_msg like 'Not posted.%';

do $$
begin
  revoke all on function public.ext_comment_blocked(uuid,bigint,text) from public;
  grant execute on function public.ext_comment_blocked(uuid,bigint,text) to api_rpc;
end $$;

-- migrate:down
update outreach.engagement set status = 'approved' where status = 'blocked';
drop function if exists public.ext_comment_blocked(uuid,bigint,text);
