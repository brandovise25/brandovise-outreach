-- migrate:up
-- Fix (24.10.2026): without a voice profile the identity checks were NULL, and is_mine is not null.
-- Adds the comments read under one post; known ones only get their reaction count refreshed.
create or replace function public.ext_comment_samples_add(p_user_id uuid, p_post jsonb, p_items jsonb, p_source text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  n_new int := 0;
  n_all int := 0;
  i jsonb;
  v_id bigint;
  me jsonb := outreach.own_identity();
begin
  perform outreach.ext_assert_user(p_user_id);
  for i in select * from jsonb_array_elements(coalesce(p_items, '[]')) limit 200 loop
    continue when coalesce(i->>'author', '') = '' or coalesce(i->>'text', '') = '';
    n_all := n_all + 1;
    v_id := null;
    if nullif(i->>'id', '') is not null then
      update outreach.comment_samples set reactions = coalesce((i->>'reactions')::int, reactions)
       where comment_urn = i->>'id' returning id into v_id;
    end if;
    if v_id is null then
      insert into outreach.comment_samples (comment_urn, post_url, post_author, post_excerpt, author, author_profile,
                                            author_headline, text, reactions, is_reply, reply_to, is_mine, lang, source)
      values (nullif(i->>'id', ''), nullif(p_post->>'url', ''), left(p_post->>'author', 200), left(p_post->>'excerpt', 1500),
              left(i->>'author', 200), left(nullif(i->>'profile', ''), 400), left(nullif(i->>'headline', ''), 300),
              left(i->>'text', 3000), (i->>'reactions')::int, coalesce((i->>'reply')::boolean, false),
              left(nullif(i->>'mentions', ''), 200),
              coalesce((i->>'mine')::boolean, false)
                or coalesce(lower(i->>'author') = me->>'name', false)
                or coalesce(lower(substring(i->>'profile' from '/in/([^/?#]+)')) = me->>'slug', false),
              left(nullif(i->>'lang', ''), 5), left(coalesce(p_source, 'robot'), 40))
      on conflict do nothing
      returning id into v_id;
      if v_id is not null then n_new := n_new + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'read', n_all, 'added', n_new);
end $$;

-- migrate:down
-- (the previous definition stays in migration 039; nothing to undo)
select 1;
