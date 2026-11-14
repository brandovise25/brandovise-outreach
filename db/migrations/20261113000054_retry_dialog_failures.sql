-- migrate:up
-- One-time (Jibran, 13.11.2026: "I want everything to work"). LinkedIn changed the invite dialog (a
-- native <dialog>, "Add a note" as a link), so every live invite failed with "No Add a note button" or
-- "The invite dialog did not open". After two such failures a person was set to 'skipped'. The reader is
-- fixed (extension, same day); these people go back to 'approved', and the sequence triggers queue their
-- invite again. Only people who were skipped for exactly this reason and were never invited.
with back as (
  update outreach.prospects p set stage = 'approved'
   where p.stage = 'skipped' and p.invited_at is null
     and exists (select 1 from outreach.action_queue q
                  where q.prospect_id = p.id and q.action = 'connect' and q.status = 'failed'
                    and (q.error like 'No "Add a note" button%' or q.error like 'The invite dialog did not open%'))
     and not exists (select 1 from outreach.action_queue q
                      where q.prospect_id = p.id and q.action = 'connect' and q.status = 'done')
  returning p.id, p.campaign_id)
insert into outreach.events (prospect_id, campaign_id, event_type, detail)
select id, campaign_id, 'stage_change',
       jsonb_build_object('from', 'skipped', 'to', 'approved', 'note', 'invite dialog reader fixed; trying again')
from back;

-- These failures were the robot's, not the person's: they no longer count towards "failed twice".
update outreach.action_queue set status = 'cancelled'
 where action = 'connect' and status = 'failed'
   and (error like 'No "Add a note" button%' or error like 'The invite dialog did not open%');

-- migrate:down
select 1;
