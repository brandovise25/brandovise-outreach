-- migrate:up
-- Campaign for peers (Jibran, 16.11.2026): people who connect and run their own business in Germany
-- selling the same kind of services (AI, automation, chatbots, no-code, digital marketing for
-- businesses). They are not clients but possible white-label partners, so they get their own thank-you:
-- "we are in the same field; if you ever need capacity, we also work white-label".
-- The incoming-connection fit check tries every active campaign, so a peer who does not fit the client
-- campaigns lands here. No keywords point at this campaign, so the robot never searches or invites for
-- it on its own. One message only, always waiting for Jibran's approval. Additive only.

insert into outreach.campaigns (id, name, description, status, language, source, raw)
values ('white-label-partner', 'White-Label-Partner (Agenturen)',
$d$Inhaber, Gründer oder Geschäftsführer eines eigenen Unternehmens in Deutschland (Agentur, Beratung, Studio oder Freelancer-Business), die selbst Leistungen rund um KI, KI-Agenten, Automatisierung, Chatbots, No-Code/Low-Code (n8n, Make, Zapier), CRM-Einführung, Software-Entwicklung oder digitales Marketing für Geschäftskunden verkaufen. Also Anbieter im selben Feld wie Jibran, mögliche White-Label-Partner, nicht deren Kunden. Eine Branchenspezialisierung ist in Ordnung (z. B. KI-Automatisierung für Pflegedienste oder Handwerk).
Ja: Das Profil zeigt eine eigene Firma oder Selbstständigkeit (Inhaber, Gründer, Geschäftsführer, Founder, Freelancer) und ein Angebot in diesen Leistungen.
Nein: Angestellte ohne eigenes Business; Konzerne und Software-Hersteller mit eigenem Produkt; Recruiter; Coaches oder Trainer ohne Umsetzungsangebot; Studierende; Personen mit Sitz außerhalb Deutschlands.$d$,
'on', 'de', 'manual',
jsonb_build_object('inbound_text',
$t$Guten Tag _FN_, _DANKE_.

Wie ich sehe, sind wir im selben Feld unterwegs: Ich baue mit meinem Team KI-Agenten und Automatisierungen für kleine Unternehmen, vor allem für Maklerbüros.

Falls Sie für eigene Kundenprojekte einmal zusätzliche Umsetzungskapazität brauchen, unterstützen wir auch als White-Label-Partner im Hintergrund, unter Ihrem Namen. Und wenn bei mir eine Anfrage aus Ihrem Bereich landet, denke ich gern an Sie.

Beste Grüße
Jibran$t$))
on conflict (id) do nothing;

-- connect (never used by the robot for this campaign: no keywords) and the one message
insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay)
select 'white-label-partner', 1, 'connect', null, interval '0'
where not exists (select 1 from outreach.campaign_actions where campaign_id = 'white-label-partner');
insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay)
select 'white-label-partner', 2, 'message',
$t$Guten Tag _FN_, danke für die Vernetzung.

Wie ich sehe, sind wir im selben Feld unterwegs: Ich baue mit meinem Team KI-Agenten und Automatisierungen für kleine Unternehmen, vor allem für Maklerbüros.

Falls Sie für eigene Kundenprojekte einmal zusätzliche Umsetzungskapazität brauchen, unterstützen wir auch als White-Label-Partner im Hintergrund, unter Ihrem Namen. Und wenn bei mir eine Anfrage aus Ihrem Bereich landet, denke ich gern an Sie.

Beste Grüße
Jibran$t$, interval '0'
where not exists (select 1 from outreach.campaign_actions where campaign_id = 'white-label-partner' and step = 2);

-- migrate:down
delete from outreach.campaign_actions where campaign_id = 'white-label-partner'
  and not exists (select 1 from outreach.prospects where campaign_id = 'white-label-partner');
delete from outreach.campaigns where id = 'white-label-partner'
  and not exists (select 1 from outreach.prospects where campaign_id = 'white-label-partner');
