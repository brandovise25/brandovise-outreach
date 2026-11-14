-- migrate:up
-- E-commerce campaign offer (Jibran, 13.11.2026): besides the support agent for e-mail and WhatsApp, the
-- campaign now offers demand forecasting and product recommendations from past sales. Only the texts and
-- the campaign's name and description change; its status stays as it is.
-- The texts below are what the robot sends in Jibran's name: he reads them before this is pushed.
update outreach.campaigns set
  name = 'E-Commerce: Support-Chatbot, Absatzprognose, Empfehlungen',
  description = 'Shopbetreiber (Shopify, Shopware, WooCommerce) | Sie-Form | Türöffner: kostenloser Shop-Check',
  invite_note = $t$Guten Tag _FN_, ich baue KI-Agenten für Online-Shops: einen Support-Chat für E-Mail und WhatsApp, der an Ihren Shop angebunden ist, und Absatzprognosen aus Ihren bisherigen Verkäufen. Ich vernetze mich gern mit Shopbetreibern.$t$,
  msg1_text = $t$Guten Tag _FN_, danke für die Vernetzung.

Ich baue für Online-Shops drei Dinge, die auf Ihren Shopdaten aufsetzen:

1. Einen Support-Chatbot für E-Mail, WhatsApp und die Kontaktseite. Er hängt direkt an Ihrem Shop (Shopify, Shopware, WooCommerce), sieht Bestellung, Sendungsnummer und Retourenstatus selbst und antwortet im Ton Ihres Shops. Was er nicht sicher beantworten kann, geht mit dem kompletten Verlauf an Ihr Team.

2. Eine Absatzprognose aus Ihren bisherigen Verkäufen: welche Artikel Sie in welcher Menge und wann brauchen, mit Saison und Aktionen.

3. Produktempfehlungen aus Ihren Bestellungen: was Kunden zusätzlich kaufen, im Shop und im Newsletter.

Keine Lösung von der Stange, sondern mit Ihren Formulierungen und Regeln. Wir sind eine deutsche GmbH und betreiben das auf Servern in Deutschland, DSGVO-konform.

Mein Vorschlag: ein kostenloser Shop-Check. Sie nennen mir die drei häufigsten Fragen aus Ihrem Posteingang und welche Verkaufsdaten Sie exportieren können. Ich schicke Ihnen zurück, was sich davon lohnt und was bei Ihrem Team besser bleibt. Kein Termin nötig.

Wo liegt bei Ihnen gerade mehr Aufwand: im Support oder in der Bestandsplanung?

Beste Grüße
Jibran Shahid
Brandovise GmbH$t$,
  msg2_text = $t$Guten Tag _FN_, kurz etwas Konkretes dazu.

Beim Support läuft es typischerweise so: Eine WhatsApp-Nachricht „Wo bleibt meine Bestellung?" wird der Bestellnummer zugeordnet, der Sendungsstatus beim Versanddienstleister abgefragt und im Ton Ihres Shops beantwortet. Retourenanfragen bekommen das Label direkt mit. Alles andere landet mit komplettem Verlauf bei Ihrem Team. Der Effekt liegt oft weniger in der gesparten Zeit als darin, dass abends und am Wochenende jemand antwortet.

Für die Prognose reicht zum Start ein Export Ihrer Bestellungen der letzten ein bis zwei Jahre: Artikelnummer, Datum, Menge. Daraus sehe ich, welche Artikel saisonal ziehen und welche nur Lagerplatz binden.

Eine Frage dazu: Haben Sie Ihre Bestellungen als Export zur Hand, und wer plant bei Ihnen den Einkauf?

Beste Grüße
Jibran$t$,
  msg3_text = $t$Guten Tag _FN_, wenn das Thema gerade nicht dran ist, lasse ich es dabei, völlig in Ordnung.

Falls doch: Der Shop-Check steht weiterhin. Zwei Stichworte von Ihnen genügen mir, zum Beispiel „WhatsApp und Retouren" oder „Prognose Herbst".

Beste Grüße
Jibran$t$
where id = 'ecommerce-first-level-support';

-- migrate:down
update outreach.campaigns set
  name = 'E-Commerce – First-Level-Support Agent',
  description = 'Shopbetreiber (Shopify, Shopware, WooCommerce) | Sie-Form | OFF bis Jibran die Texte freigibt',
  invite_note = $t$Guten Tag _FN_, kurze Frage an Shopbetreiber: Wie viele „Wo ist meine Bestellung?"-Nachrichten beantwortet Ihr Team pro Woche noch von Hand – über WhatsApp, Mail und Shop gleichzeitig?

Genau das baue ich als KI-Agenten nach. Ich vernetze mich gern.$t$,
  msg1_text = $t$Guten Tag _FN_, danke für die Vernetzung.

Im Onlinehandel läuft der Support über drei Kanäle gleichzeitig: WhatsApp, das Mail-Postfach und die Kontaktseite im Shop. Dieselben Fragen, jeden Tag – Sendungsstatus, Retoure, Rechnung, Größe, Lieferzeit. Und je nach Kanal antwortet jemand anderes, mit einem anderen Ton und ohne zu wissen, was gestern schon besprochen wurde.

Genau diesen First-Level-Support baue ich als Agenten nach. Er hängt direkt an Ihrem Shop – Shopify, Shopware, WooCommerce – und sieht Bestellung, Sendungsnummer und Retourenstatus selbst. Was er nicht sicher beantworten kann, geht mit dem kompletten Verlauf an Ihr Team.

Kein Werkzeug von der Stange, sondern mit Ihren Formulierungen und Ihren Regeln. Wir sind eine deutsche GmbH und betreiben das auf Servern in Deutschland – DSGVO-konform.

Mein Vorschlag: ein kostenloser Support-Check. Sie nennen mir die drei häufigsten Fragen aus Ihrem Posteingang, ich schicke Ihnen zurück, welche davon ein Agent sauber übernehmen kann und welche bei Ihren Leuten bleiben sollten. Kein Termin nötig, der Aufwand liegt bei mir.

Welcher Kanal frisst bei Ihnen gerade die meiste Zeit?

Beste Grüße
Jibran Shahid
Brandovise GmbH$t$,
  msg2_text = $t$Guten Tag _FN_, kurz etwas Konkretes, damit es greifbarer wird.

Bei einem Händler läuft seit einigen Monaten Folgendes von allein: Eine WhatsApp-Nachricht „Wo bleibt meine Bestellung?" wird der Bestellnummer zugeordnet, der Sendungsstatus beim Versanddienstleister geholt und beantwortet – im Ton des Shops, nicht im Ton eines Bots. Retourenanfragen bekommen das Label direkt mit. Alles andere landet beim Team, mit dem kompletten Verlauf daneben.

Der eigentliche Effekt war nicht die gesparte Zeit. Es war, dass abends um 22 Uhr und am Wochenende jemand antwortet.

Eine Frage dazu: Wenn bei Ihnen heute eine Support-Nachricht über WhatsApp kommt – wie findet die zur Bestellung im Shop?

Beste Grüße
Jibran$t$,
  msg3_text = $t$Guten Tag _FN_, wenn das Thema gerade nicht dran ist, lasse ich es dabei – völlig in Ordnung.

Falls doch: Der Support-Check steht weiterhin. Zwei Stichworte von Ihnen genügen mir („WhatsApp und Retouren").

Beste Grüße
Jibran$t$
where id = 'ecommerce-first-level-support';
