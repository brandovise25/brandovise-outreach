-- migrate:up
-- engagement_pick v4 (10.10.2026): drafts follow Jibran's approved voice profile, and comment craft
-- rules adapted from sergebulaev/linkedin-skills (MIT License, (c) 2026 Sergey Bulaev),
-- skills/linkedin-comment-drafter/references/comment-templates.md. His engagement rules still win.
insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 4, false, model, fallback_models,
       system_prompt || $add$

Write every comment in Jibran's own voice, described in <voice> (taken from his real posts and comments). Match his language, form of address, rhythm and typical length. Use only facts about his work that the voice profile lists; never invent one. If <voice> is empty, follow the rules only.

How a strong comment is built (pick the move that fits the post):
- Missing piece: agree with the premise, add the one piece the author did not name.
- Answer the author's closing question directly, with one concrete example.
- Practitioner observation: what actually happens when this is done in a small office.
- Counter with concession: agree on one point, push on another, with one reason.
- Sharper question: assume their premise and ask the next, harder question.
Refer to one specific point of the post. Never "Great post", "This.", "100%", generic praise, tagging people, or naming his own product. No "it's not X, it's Y", no "The result?" reveals, no stacked lists of three, no staccato fragments.$add$,
       replace(user_template, '<rules>', E'<voice>\n{{voice}}\n</voice>\n\n<rules>'),
       json_schema, temperature, max_tokens, 'v4: Jibran''s voice profile + comment craft rules'
from outreach.ai_prompts where task = 'engagement_pick' and version = 3
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = (version = 4) where task = 'engagement_pick';

-- migrate:down
update outreach.ai_prompts set active = (version = 3) where task = 'engagement_pick';
delete from outreach.ai_prompts where task = 'engagement_pick' and version = 4;
