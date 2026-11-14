-- Rolling invite limits. Runs in a transaction that is rolled back.
begin;
delete from outreach.events where event_type in ('invite_sent', 'message_sent');
update outreach.settings set value = '' where key in ('linkedin_limit_alert', 'invites_paused_until');
update outreach.settings set value = 'false' where key = 'paused';
insert into outreach.settings (key, value) values ('weekly_invite_cap', '100'), ('pending_invite_cap', '300')
  on conflict (key) do update set value = excluded.value;
insert into outreach.settings (key, value) values ('linkedin_pending_invites', '50'), ('linkedin_pending_checked_at', to_jsonb(now())::text)
  on conflict (key) do update set value = excluded.value;

-- 100 invites spread over the last 6 days: the week is full even across a Monday
insert into outreach.events (event_type, ok, occurred_at)
select 'invite_sent', true, now() - interval '6 days' + (g * interval '1 hour') from generate_series(1, 100) g;
do $$ declare l jsonb := outreach.limits(); begin
  assert l->>'invite_status' = 'weekly_cap', 'rolling week full: ' || l::text;
  assert (l->>'invites_resume_at')::timestamptz between now() + interval '1 day' - interval '2 hours' and now() + interval '1 day' + interval '2 hours',
    'resumes when the oldest invite leaves the window: ' || l::text;
end $$;

-- invites older than 7 days no longer count
update outreach.events set occurred_at = occurred_at - interval '2 days' where event_type = 'invite_sent';
do $$ declare l jsonb := outreach.limits(); begin
  assert (l->>'invites_this_week')::int < 100, l::text;
end $$;

-- a stale LinkedIn pending count is not replaced by the lower database count
delete from outreach.events where event_type = 'invite_sent';
update outreach.settings set value = '328' where key = 'linkedin_pending_invites';
update outreach.settings set value = to_jsonb(now() - interval '3 days')::text where key = 'linkedin_pending_checked_at';
do $$ declare l jsonb := outreach.limits(); begin
  assert (l->>'pending_invites')::int = 328, 'stale count still used: ' || l::text;
  assert l->>'invite_status' = 'pending_cap', l::text;
end $$;
update outreach.settings set value = '120' where key = 'linkedin_pending_invites';
do $$ declare l jsonb := outreach.limits(); begin
  assert l->>'invite_status' = 'pending_unknown', 'stale count blocks until the next sync: ' || l::text;
end $$;
update outreach.settings set value = to_jsonb(now())::text where key = 'linkedin_pending_checked_at';
do $$ declare l jsonb := outreach.limits(); begin
  assert l->>'invite_status' = 'open', l::text;
end $$;
do $$ begin raise notice '003_limits: all checks passed'; end $$;
rollback;
