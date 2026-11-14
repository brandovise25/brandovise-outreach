-- Defaults for the settings the extension and API add. Applied on every start by server/src/cli/migrate.ts.
-- Insert-if-missing only: values Jibran has changed are never overwritten.
insert into outreach.settings (key, value, note) values
  ('ext_enabled_actions', '["scan","analyze","draft"]', 'Actions the extension may perform. "send" is added only at Phase 4 sign-off.'),
  ('ext_dry_run', 'true', 'true: the extension does everything except pressing the final Send/Connect.'),
  ('ext_min_version', '0.1.0', 'Extensions below this version are refused by the API.'),
  ('ai_daily_budget_usd', '2.00', 'OpenRouter spend limit per day (Europe/Berlin).'),
  ('run_caps', '{"max_profile_visits":12,"max_page_loads":25}', 'Per-run caps for the extension robot run.'),
  ('pacing', '{"settle_s":[3,6],"scroll_ticks":[3,5],"scroll_pause_s":[2,5],"dwell_s":[20,45],"between_profiles_s":[45,120],"breather_every":[4,5],"breather_s":[120,240],"between_sends_s":[40,120],"browse_window":["07:00","21:00"],"timezone":"Europe/Berlin"}', 'Browsing pace, seeded from the browsing_conduct doc.'),
  ('run_schedule', '{"timezone":"Europe/Berlin","times":["07:58","12:58","17:58"]}', 'When the extension starts a robot run. robot_schedule stays the send window.')
on conflict (key) do nothing;
insert into outreach.settings (key, value, note) values
  ('comment_posting_live', 'false', 'false = practice: the extension types the comment and finds the Post button but does not press it.')
on conflict (key) do nothing;
insert into outreach.settings (key, value, note) values
  ('comment_autopost', 'false', 'post approved comments automatically, spread over the day (live mode only)'),
  ('comment_autopost_daily_max', '5', 'max automatic comment posts per day')
on conflict (key) do nothing;
