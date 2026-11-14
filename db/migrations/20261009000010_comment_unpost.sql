-- migrate:up
-- "Not posted after all": approving again clears the posted time, so the record stays truthful.
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
    reviewed_at = now(),
    posted_at = case p_decision when 'posted' then now() when 'approve' then null else posted_at end
  where id = p_id;
  if not found then raise exception 'unknown comment draft' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- migrate:down
select 1;
