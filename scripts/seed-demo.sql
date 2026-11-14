-- LOCAL DEMO DATA ONLY: invented people for previewing the side panel. Never run on staging/prod.
-- Remove again with: delete from outreach.prospects where source = 'demo'; (cascades to queue/events)
do $$
begin
  if exists (select 1 from outreach.prospects where source <> 'demo' and source is not null and id > 0 limit 1)
     and (select count(*) from outreach.prospects) > 50 then
    raise exception 'refusing: this database looks like it holds real data';
  end if;
end $$;

insert into outreach.campaigns (id, name, status, description) values
  ('ki-agenten-makler', 'KI-Agenten Makler', 'on', 'Unabhängige Versicherungsmakler')
on conflict (id) do update set status = 'on';
insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay) values
  ('ki-agenten-makler', 1, 'connect', null, '0'),
  ('ki-agenten-makler', 2, 'message', 'danke für die Vernetzung, _FN_. ...', '4 hours')
on conflict do nothing;

insert into outreach.prospects (linkedin_url, first_name, full_name, headline, company, campaign_id, stage, source, raw)
  values
   ('https://www.linkedin.com/in/demo-maria-beispiel/', 'Maria', 'Maria Beispiel', 'Versicherungsmaklerin (§34d) | Inhaberin', 'Beispiel Finanz', 'ki-agenten-makler', 'approved', 'demo',
    '{"fit":{"status":"yes","reason":"Owner of an independent broker office (§34d).","evidence":["Versicherungsmaklerin (§34d)"]},"trigger":{"type":"post","note":"Beitrag über doppelte Datenpflege zwischen MVP und Posteingang","url":""}}'),
   ('https://www.linkedin.com/in/demo-tom-muster/', 'Tom', 'Tom Muster', 'Geschäftsführer | Muster GmbH', 'Muster GmbH', 'ki-agenten-makler', 'approved', 'demo',
    '{"fit":{"status":"unsure","reason":"Geschäftsführer without a readable broker signal.","evidence":[]},"trigger":{"type":"none"}}')
  on conflict (linkedin_url) do nothing;

-- Separate statement: the triggers' queue rows are only visible after the insert has finished.
update outreach.action_queue q set status = 'proposed',
  message_text = case p.first_name
    when 'Maria' then 'Guten Tag Maria, Ihr Beitrag zur doppelten Datenpflege zwischen MVP und Posteingang trifft genau das, was ich in Maklerbüros sehe. Ich baue dafür KI-Agenten, die das übernehmen. Ich vernetze mich gern.'
    else 'Guten Tag Tom, ich baue für Maklerbüros KI-Agenten für Schadenaufnahme, Angebote und E-Mail-Ablage. Ich vernetze mich gern.' end
from outreach.prospects p where q.prospect_id = p.id and p.source = 'demo' and q.status = 'scheduled';

insert into outreach.candidates (full_name, headline, company, linkedin_url, keyword, score, verdict, campaign_id, reason) values
  ('Lena Probe', 'Unabhängige Finanzmaklerin · Partnerin Fonds Finanz', 'Probe Finanz', 'https://www.linkedin.com/in/demo-lena-probe/', 'Maklerbüro Digitalisierung', 82, 'staged', 'ki-agenten-makler', 'Independent broker, pool partner; posts about MVP data entry.'),
  ('Jonas Test', 'Mehrfachagent | Versicherungen & Vorsorge', null, 'https://www.linkedin.com/in/demo-jonas-test/', 'feed:https://www.linkedin.com/feed/update/urn:li:activity:1/', 74, 'staged', 'ki-agenten-makler', 'Commented on a post about Schadenbearbeitung; Mehrfachagent.');

insert into outreach.engagement (post_urn, post_url, post_excerpt, post_age, author_name, author_headline, author_profile, comment_draft, reason)
values ('urn:li:activity:demo1', 'https://www.linkedin.com/feed/', 'Wir haben dieses Jahr 30 % mehr Schadenmeldungen per E-Mail bekommen – der Innendienst kommt kaum hinterher.', '1d',
        'Sabine Vorlage', 'Inhaberin eines Maklerbüros', 'https://www.linkedin.com/in/demo-sabine/',
        'Genau da setzt es an: Die Meldung ist selten das Problem, sondern das Zuordnen zum richtigen Vertrag.

Wie viele der Mails landen bei Ihnen schon heute automatisch in der richtigen Akte?',
        'Broker owner, 2.1k followers, post 1 day old with 14 comments.')
on conflict (post_urn) do nothing;

insert into outreach.runs (kind, status, started_at, finished_at, notes) values
  ('robot', 'ok', now() - interval '3 hours', now() - interval '2 hours 50 minutes', 'demo: 2 proposed, 1 acceptance'),
  ('prospecting', 'ok', now() - interval '1 day', now() - interval '23 hours', 'demo: 2 staged');
insert into outreach.events (prospect_id, event_type, detail)
select id, 'visit', '{"note":"fit yes · trigger post"}' from outreach.prospects where linkedin_url = 'https://www.linkedin.com/in/demo-maria-beispiel/';
