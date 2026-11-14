-- migrate:up
-- engagement_pick v3: a 19-post scan came back empty (answer too long). Scans are now split into
-- batches of 10 in code; skip reasons are kept short and the output limit is higher.
insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 3, false, model, fallback_models,
       system_prompt || $add$
- Keep skip reasons to one short sentence (under 20 words) and reach_note empty for skips.$add$,
       user_template, json_schema, temperature, 8000,
       'v3: short skip reasons, max_tokens 8000 (with batches of 10 posts)'
from outreach.ai_prompts where task = 'engagement_pick' and version = 2
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = false where task = 'engagement_pick' and version <> 3;
update outreach.ai_prompts set active = true where task = 'engagement_pick' and version = 3;

-- migrate:down
update outreach.ai_prompts set active = false where task = 'engagement_pick' and version = 3;
update outreach.ai_prompts set active = true where task = 'engagement_pick' and version = 2;
delete from outreach.ai_prompts where task = 'engagement_pick' and version = 3;
