-- migrate:up
-- Sending temperature makes OpenRouter skip every zero-retention endpoint that does not support it
-- (with provider.require_parameters = true), which left no endpoint for claude-haiku-5.5.
-- Temperature is now optional and only sent when a prompt sets it.
alter table outreach.ai_prompts alter column temperature drop not null;
alter table outreach.ai_prompts alter column temperature drop default;
update outreach.ai_prompts set temperature = null where task in ('fit_check', 'trigger_extract') and version = 1;

-- migrate:down
update outreach.ai_prompts set temperature = 0 where temperature is null;
alter table outreach.ai_prompts alter column temperature set default 0;
alter table outreach.ai_prompts alter column temperature set not null;
