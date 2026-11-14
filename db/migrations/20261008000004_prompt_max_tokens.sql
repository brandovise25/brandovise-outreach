-- migrate:up
-- 400 tokens was too tight: verbose reasons got cut off mid-JSON. Reasons are shortened in code.
update outreach.ai_prompts set max_tokens = 1000 where task in ('fit_check', 'trigger_extract') and version = 1 and max_tokens = 400;

-- migrate:down
update outreach.ai_prompts set max_tokens = 400 where task in ('fit_check', 'trigger_extract') and version = 1 and max_tokens = 1000;
