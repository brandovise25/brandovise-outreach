-- migrate:up
-- 1. Post links found by the robot may also be ugcPost URNs (decoded from "EgsI…" card keys).
-- 2. comment_factcheck v4: the fact check only checks facts. It blocked #44 for using "Sie" under a casual
--    post; the address form is Jibran's own rule (formal Sie in German), checked in code, not a fact.

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
    post_url = coalesce(nullif(post_url, ''), case when p_result->>'postLink' ~ '^https://www\.linkedin\.com/feed/update/urn:li:(activity|ugcPost):[0-9]+/$'
                                       then p_result->>'postLink' end)
  where id = p_id;
  if not found then raise exception 'unknown comment draft' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'posted', v_posted, 'check', v_unsure);
end $$;

insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 4, false, model, fallback_models,
       system_prompt || $add$
Check FACTS only: is anything in the comment wrong or not supported about the post, its author or third parties? Never block for tone, style, language, length, formality or the form of address (Sie/du, formal/casual): those are Jibran's own rules and are checked elsewhere.$add$,
       user_template, json_schema, temperature, max_tokens, 'v4: facts only, never tone or Sie/du'
from outreach.ai_prompts where task = 'comment_factcheck' and version = 3
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = (version = 4) where task = 'comment_factcheck';

-- migrate:down
update outreach.ai_prompts set active = (version = 3) where task = 'comment_factcheck';
delete from outreach.ai_prompts where task = 'comment_factcheck' and version = 4;
