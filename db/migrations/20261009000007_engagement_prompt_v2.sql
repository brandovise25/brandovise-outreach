-- migrate:up
-- engagement_pick v2, after Jibran's review of the first real draft (09.10.2026):
-- the closing question went to the audience ("bei euch") instead of the author, and the reason claimed
-- an "ICP audience in the thread" on a post with 0 comments.
insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 2, false, model, fallback_models,
       system_prompt || $add$

Hard rules that drafts get rejected for:
- The closing question is addressed to the AUTHOR and must be answerable from the author's own work or experience. Never ask the audience ("bei euch", "Wie seht ihr das?", "Was denkt ihr?"). Check who the author is (headline): ask what fits their role.
- Match the post's form of address: if the author writes "du/ihr", use "du"; otherwise use "Sie".
- reason and reach_note may only state facts visible in <page_data> (followers, age, reaction and comment counts, headline). Never claim an audience, ICP commenters or momentum that the data does not show. A post with 0 comments has no audience in the thread yet.$add$,
       user_template, json_schema, temperature, max_tokens,
       'v2: question to the author, matching address form, no invented facts in reasons'
from outreach.ai_prompts where task = 'engagement_pick' and version = 1
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = false where task = 'engagement_pick' and version = 1;
update outreach.ai_prompts set active = true where task = 'engagement_pick' and version = 2;

-- migrate:down
update outreach.ai_prompts set active = false where task = 'engagement_pick' and version = 2;
update outreach.ai_prompts set active = true where task = 'engagement_pick' and version = 1;
delete from outreach.ai_prompts where task = 'engagement_pick' and version = 2;
