-- migrate:up
-- comment_factcheck v2: v1 ran out of output at 600 tokens on a real comment. Shorter issue lines,
-- higher limit.
insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 2, false, model, fallback_models,
       system_prompt || $add$
Write each issue as one short line (under 25 words). At most 4 issues.$add$,
       user_template, json_schema, temperature, 1500, 'v2: short issues, max_tokens 1500'
from outreach.ai_prompts where task = 'comment_factcheck' and version = 1
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = (version = 2) where task = 'comment_factcheck';

-- migrate:down
update outreach.ai_prompts set active = (version = 1) where task = 'comment_factcheck';
delete from outreach.ai_prompts where task = 'comment_factcheck' and version = 2;
