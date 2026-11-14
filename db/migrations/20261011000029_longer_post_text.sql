-- migrate:up
-- Keep up to 3000 characters of a post (was 600): the fact check compares the comment with this text,
-- and a detail after character 600 (e.g. "24-hour veto window", 11.10.2026) was reported as invented.

create or replace function public.ext_save_engagement(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  n int;
begin
  perform outreach.ext_assert_user(p_user_id);
  insert into outreach.engagement (post_key, post_urn, post_url, post_excerpt, post_age, author_name, author_headline,
                                   author_profile, comment_draft, reason, marketing_level, status, source)
  select i->>'post_key', nullif(i->>'post_urn', ''), nullif(i->>'post_url', ''), left(i->>'post_excerpt', 3000),
         i->>'post_age', i->>'author_name', left(i->>'author_headline', 300), nullif(i->>'author_profile', ''),
         nullif(i->>'comment', ''), left(i->>'reason', 500), (i->>'marketing_level')::int,
         case when i->>'verdict' = 'draft' then 'drafted' else 'skipped' end, 'extension'
  from jsonb_array_elements(p_items) i
  where i->>'post_key' is not null
  on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'saved', n);
end $$;

-- migrate:down
-- (previous definition in 20261009000006_engagement_scan.sql)
