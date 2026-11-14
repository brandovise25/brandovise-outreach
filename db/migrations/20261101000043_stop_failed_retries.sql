-- migrate:up
-- Retry loop (Jibran, 31.10.2026): every failed invite came back as a new queue row, ahead of everyone
-- else, so the same 3 people were tried ~10 times each in 5 days and nobody else was reached.
create or replace function public.ext_send_result(p_user_id uuid, p_queue_id bigint, p_practice boolean, p_ok boolean, p_note text, p_detail jsonb)
returns jsonb
language plpgsql security definer
set search_path = outreach, public
as $$
declare
  q outreach.action_queue;
  dry boolean := coalesce(outreach.ext_setting('ext_dry_run') <> 'false'::jsonb, true);
  v_fails int;
begin
  perform outreach.ext_assert_user(p_user_id);
  select * into q from outreach.action_queue where id = p_queue_id for update;
  if not found then raise exception 'unknown queue row' using errcode = 'P0002'; end if;
  if p_practice then
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values ('send_practice', p_ok, q.prospect_id, jsonb_build_object('queue_id', q.id, 'action', q.action, 'note', left(p_note, 500)) || coalesce(p_detail, '{}'));
    return jsonb_build_object('ok', true, 'practice', true);
  end if;
  if dry then raise exception 'dry run is on: live results are not accepted' using errcode = '22023'; end if;
  if q.status <> 'approved' then raise exception 'row is %, not approved', q.status using errcode = '22023'; end if;
  if p_ok then
    update outreach.action_queue set status = 'done', executed_at = now() where id = q.id;
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values (case q.action when 'connect' then 'invite_sent' when 'withdraw' then 'invite_withdrawn' else 'message_sent' end,
            true, q.prospect_id, jsonb_build_object('queue_id', q.id, 'source', 'extension') || coalesce(p_detail, '{}'));
  else
    update outreach.action_queue set status = 'failed', error = left(p_note, 500) where id = q.id;
    insert into outreach.events (event_type, ok, prospect_id, detail)
    values ('send_failed', false, q.prospect_id, jsonb_build_object('queue_id', q.id, 'action', q.action, 'note', left(p_note, 500)));
    -- A failed invite or message comes back as a new queue row (robot_tick). After the second failure for
    -- the same person it stops: 'skipped' cancels what is open and keeps them out of the queue.
    if q.action in ('connect', 'message') then
      select count(*) into v_fails from outreach.action_queue
       where prospect_id = q.prospect_id and action = q.action and status = 'failed';
      if v_fails >= 2 then
        update outreach.prospects set stage = 'skipped'
         where id = q.prospect_id and stage in ('approved', 'visited', 'accepted', 'msg1_sent', 'msg2_sent', 'msg3_sent');
        if found then
          insert into outreach.events (event_type, ok, prospect_id, detail)
          values ('skipped', false, q.prospect_id,
                  jsonb_build_object('reason', 'sending failed ' || v_fails || ' times: ' || left(p_note, 200), 'queue_id', q.id));
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'practice', false);
end $$;

-- No one-time clean-up of people who already failed twice (Jibran, 05.11.2026): those failures came from
-- the invite dialog moving into a shadow root, which is fixed, so they stay in the queue.

-- migrate:down
-- (the previous ext_send_result stays in migration 034; skipped prospects can be set back by hand)
select 1;
