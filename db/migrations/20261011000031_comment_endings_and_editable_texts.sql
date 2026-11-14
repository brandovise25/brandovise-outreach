-- migrate:up
-- 1. Comment endings (Jibran, 11.10.2026): not every comment ends with a question. Default ending is a
--    short, specific appreciation of the author's point; a question only when the post asks one or
--    invites answers. Generic praise ("Great post") stays out.
-- 2. Settings: the rule texts (docs) and AI prompts can be edited in the app. Every save is a new
--    version; earlier versions stay and can be restored.

do $do$
begin
  if outreach.doc('engagement_rules') is not null then
    perform outreach.doc_put('engagement_rules',
  replace(replace(outreach.doc('engagement_rules'),
    'DRAFTING (Three-Part framework: genuine agreement with their specific point -> Jibran''s world -> open question):',
    'DRAFTING (Three-Part framework: genuine agreement with their specific point -> Jibran''s world -> specific appreciation, or a question only when it fits):'),
    '- End on a specific question the AUTHOR can answer, never "Was denkt ihr?".',
    '- Default ending: one short, specific appreciation of what is strong in their post (name the point, e.g. "Der Gedanke mit ... ist stark, weil ..."). Never generic praise like "Toller Beitrag" or "Great post". End with a question only when the post itself asks one or invites answers (then answer it, or ask one question the AUTHOR can answer, never "Was denkt ihr?"). At most about 1 in 3 comments ends with a question.'),
  'comment endings: specific appreciation by default, question only when it fits (Jibran 11.10.2026)', 'jibran');
  end if;
end $do$;

insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
select task, 5, false, model, fallback_models,
       replace(system_prompt, '- Sharper question: assume their premise and ask the next, harder question.',
               '- Sharper question (only when a question fits): assume their premise and ask the next, harder question.')
       || $add$

Ending: by default close with one short, specific appreciation of what is strong in the post (name the point and why it works). A question only when the post asks one or invites answers; at most about 1 in 3 comments. Never generic praise.$add$,
       user_template, json_schema, temperature, max_tokens, 'v5: appreciation ending by default, question only when it fits'
from outreach.ai_prompts where task = 'engagement_pick' and version = 4
on conflict (task, version) do nothing;
update outreach.ai_prompts set active = false where task = 'engagement_pick' and active;
update outreach.ai_prompts set active = true where task = 'engagement_pick' and version = 5;

-- ---------- editable texts for the Settings tab ----------

create or replace function public.ext_editable_texts(p_user_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  return jsonb_build_object(
    'docs', (select coalesce(jsonb_agg(jsonb_build_object('key', d.doc_key, 'version', d.version, 'content', d.content,
                      'updated_at', d.created_at, 'by', d.created_by) order by d.doc_key), '[]')
             from outreach.v_docs_current d
             where d.doc_key in ('engagement_rules', 'voice_rules', 'banned_phrases', 'target_groups',
                                 'targeting_rules', 'trigger_rules', 'reply_rules', 'prospecting_keywords', 'browsing_conduct')),
    'prompts', (select coalesce(jsonb_agg(jsonb_build_object('task', p.task, 'version', p.version, 'model', p.model,
                      'system_prompt', p.system_prompt, 'user_template', p.user_template, 'note', p.note,
                      'versions', (select count(*) from outreach.ai_prompts x where x.task = p.task)) order by p.task), '[]')
                from outreach.ai_prompts p where p.active));
end $$;

create or replace function public.ext_doc_save(p_user_id uuid, p_key text, p_content text, p_note text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
begin
  perform outreach.ext_assert_user(p_user_id);
  if p_key not in ('engagement_rules', 'voice_rules', 'banned_phrases', 'target_groups', 'targeting_rules',
                   'trigger_rules', 'reply_rules', 'prospecting_keywords', 'browsing_conduct') then
    raise exception 'text % cannot be edited here', p_key using errcode = '22023';
  end if;
  return jsonb_build_object('version', outreach.doc_put(p_key, p_content, coalesce(p_note, 'edited in the app'), 'jibran'));
end $$;

-- New prompt version from the active one with Jibran's texts; it becomes active at once.
create or replace function public.ext_prompt_save(p_user_id uuid, p_task text, p_system text, p_template text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare v_next int;
begin
  perform outreach.ext_assert_user(p_user_id);
  select max(version) + 1 into v_next from outreach.ai_prompts where task = p_task;
  if v_next is null then raise exception 'unknown task %', p_task using errcode = 'P0002'; end if;
  insert into outreach.ai_prompts (task, version, active, model, fallback_models, system_prompt, user_template, json_schema, temperature, max_tokens, note)
  select task, v_next, false, model, fallback_models, p_system, p_template, json_schema, temperature, max_tokens, 'edited in the app'
  from outreach.ai_prompts where task = p_task and active;
  -- one active version at a time (unique index): switch off first, then on
  update outreach.ai_prompts set active = false where task = p_task and active;
  update outreach.ai_prompts set active = true where task = p_task and version = v_next;
  return jsonb_build_object('version', v_next);
end $$;

-- Back to the previous version (one step).
create or replace function public.ext_prompt_revert(p_user_id uuid, p_task text)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare v_cur int; v_prev int;
begin
  perform outreach.ext_assert_user(p_user_id);
  select version into v_cur from outreach.ai_prompts where task = p_task and active;
  select max(version) into v_prev from outreach.ai_prompts where task = p_task and version < v_cur;
  if v_prev is null then raise exception 'no earlier version of %', p_task using errcode = '22023'; end if;
  update outreach.ai_prompts set active = false where task = p_task and active;
  update outreach.ai_prompts set active = true where task = p_task and version = v_prev;
  return jsonb_build_object('version', v_prev);
end $$;

do $$
declare f text;
begin
  foreach f in array array['ext_editable_texts(uuid)', 'ext_doc_save(uuid,text,text,text)',
                           'ext_prompt_save(uuid,text,text,text)', 'ext_prompt_revert(uuid,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to api_rpc', f);
  end loop;
end $$;

-- migrate:down
drop function if exists public.ext_prompt_revert(uuid,text);
drop function if exists public.ext_prompt_save(uuid,text,text,text);
drop function if exists public.ext_doc_save(uuid,text,text,text);
drop function if exists public.ext_editable_texts(uuid);
update outreach.ai_prompts set active = (version = 4) where task = 'engagement_pick';
delete from outreach.ai_prompts where task = 'engagement_pick' and version = 5;
