-- migrate:up
-- comment_factcheck v3: v2 blocked the level-1 proof clause ("Bei den Maklerbüros, mit denen wir
-- arbeiten"), which the engagement rules explicitly allow. Statements about Jibran's own work are not
-- claims about the post.
insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 3, false, model, fallback_models,
       system_prompt || $add$
Only check claims about the POST, its AUTHOR or third parties. Statements about Jibran's own work or experience ("bei den Maklerbüros, mit denen wir arbeiten", "in the automation work I do", "what I usually see") are allowed by his rules: do not block them as facts missing from the post, and do not treat one such subordinate clause in the middle of the comment as a pitch.$add$,
       user_template, json_schema, temperature, max_tokens, 'v3: own-experience statements are allowed (level-1 clause)'
from outreach.ai_prompts where task = 'comment_factcheck' and version = 2
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = (version = 3) where task = 'comment_factcheck';

-- migrate:down
update outreach.ai_prompts set active = (version = 2) where task = 'comment_factcheck';
delete from outreach.ai_prompts where task = 'comment_factcheck' and version = 3;
