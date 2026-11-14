import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBOOK } from '@outreach/shared';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';
import { insertOpener } from '../src/prepare.ts';

// The prepare step with company signals: the invite note and the first message open with one website
// fact chosen by the playbook, and what was used is stored for the statistics.

let note = '';
let opener = '';
const bodies: string[] = [];
const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
  const body = String(init!.body);
  bodies.push(body);
  const content = body.includes('"opener"')
    ? JSON.stringify({ opener })
    : JSON.stringify({ notes: [{ index: 0, note }] });
  return new Response(
    JSON.stringify({
      model: 'anthropic/claude-sonnet-5.5',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 200, cost: 0.01 },
    }),
  );
});
const { app, db } = await makeApp(fetchMock);
let token = '';
afterAll(async () => {
  await owner((c) =>
    c.query(`select outreach.doc_put('signal_playbook', $1, 'test reset')`, [DEFAULT_PLAYBOOK]),
  );
  await app.close();
  await db.end();
});
const auth = () => ({ authorization: `Bearer ${token}` });
const prepare = () =>
  app
    .inject({ method: 'POST', url: '/panel/queue/prepare', headers: auth() })
    .then((r) => r.json());
const row = (id: number) =>
  owner((c) =>
    c.query(
      `select status, error, message_text, personalization from outreach.action_queue where id = $1`,
      [id],
    ),
  ).then((r) => r.rows[0]);

const NOTE =
  'Ihr Shop läuft auf Shopify und Kunden erreichen Sie auch per WhatsApp. Ich baue Support-Chats für Online-Shops und tausche mich gern mit Shopbetreibern aus.';
const OPENER =
  'Mir ist aufgefallen, dass Ihre Kunden Sie auch per WhatsApp erreichen. Genau um diesen Kanal geht es mir.';
const MSG1 =
  'Guten Tag Rita, danke für die Vernetzung.\n\nIch baue für Online-Shops drei Dinge.\n\nBeste Grüße\nJibran';

beforeEach(async () => {
  fetchMock.mockClear();
  bodies.length = 0;
  note = NOTE;
  opener = OPENER;
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  await owner(async (c) => {
    await c.query(
      `delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects`,
    );
    await c.query(
      `delete from outreach.candidates; delete from outreach.observations; delete from outreach.companies`,
    );
    await c.query(`insert into outreach.settings (key, value, note) values ('auto_approve', 'false', 't')
                   on conflict (key) do update set value = 'false'`);
    await c.query(`update outreach.settings set value = 'true' where key = 'ext_dry_run'`);
    await c.query(`delete from outreach.campaign_actions where campaign_id = 'test-camp'`);
    await c.query(`delete from outreach.campaigns where id = 'test-camp'`);
    await c.query(
      `insert into outreach.campaigns (id, name, status) values ('test-camp', 'Online-Shops', 'on')`,
    );
    await c.query(`insert into outreach.campaign_actions (campaign_id, step, action_type) values
                     ('test-camp', 1, 'connect'), ('test-camp', 2, 'message'), ('test-camp', 3, 'message')`);
    await c.query(`select outreach.doc_put('signal_playbook', $1, 'test')`, [
      '[test-camp]\nSUPPORT_WHATSAPP + NO_CHAT_WIDGET => support | Mention WhatsApp.\nSHOP_PLATFORM => forecast | Mention the shop system.',
    ]);
    await c.query(
      `insert into outreach.companies (id, domain, source) values (501, 'laufshop.example', 'manual'), (502, 'ohne.example', 'manual')`,
    );
    await c.query(`insert into outreach.observations (company_id, signal_code, value_text, value_num, confidence, evidence_url) values
        (501, 'SHOP_PLATFORM', 'Shopify', null, 0.95, 'https://laufshop.example/'),
        (501, 'SUPPORT_WHATSAPP', null, 1, 0.95, 'https://laufshop.example/kontakt'),
        (501, 'NO_CHAT_WIDGET', null, 1, 0.6, 'https://laufshop.example/')`);
    await c.query(
      `insert into outreach.prospects (id, linkedin_url, full_name, first_name, headline, company, stage, campaign_id, company_id, accepted_at, raw) values
        (9301, 'https://www.linkedin.com/in/ralf-s/', 'Ralf Schuh', 'Ralf', 'Inhaber bei Laufshop', 'Laufshop', 'approved', 'test-camp', 501, null, '{"fit":{"evidence":["Inhaber bei Laufshop"]}}'),
        (9302, 'https://www.linkedin.com/in/rita-s/', 'Rita Schuh', 'Rita', 'Geschäftsführerin Laufshop', 'Laufshop', 'accepted', 'test-camp', 501, now(), '{}'),
        (9303, 'https://www.linkedin.com/in/otto-o/', 'Otto Ohne', 'Otto', 'Inhaber', 'Ohne', 'accepted', 'test-camp', 502, now(), '{}'),
        (9304, 'https://www.linkedin.com/in/rosa-s/', 'Rosa Schuh', 'Rosa', 'Inhaberin Laufshop', 'Laufshop', 'msg1_sent', 'test-camp', 501, now(), '{}')`,
    );
    // the sequence triggers may have queued rows for these people already; the test sets its own
    await c.query(`delete from outreach.action_queue`);
    await c.query(
      `insert into outreach.action_queue (id, prospect_id, campaign_id, action, step, message_text, due_at, status) values
        (7301, 9301, 'test-camp', 'connect', 1, 'Vorlage', now() - interval '1 hour', 'scheduled'),
        (7302, 9302, 'test-camp', 'message', 2, $1, now() - interval '1 hour', 'scheduled'),
        (7303, 9303, 'test-camp', 'message', 2, $1, now() - interval '1 hour', 'scheduled'),
        (7304, 9304, 'test-camp', 'message', 3, 'Guten Tag Rita, kurz etwas Konkretes dazu.', now() - interval '1 hour', 'scheduled')`,
      [MSG1],
    );
  });
});

describe('prepare with company signals', () => {
  it('gives the note writer the chosen fact and stores which one was used', async () => {
    const r = await prepare();
    expect(r).toMatchObject({ candidates: 4, proposed: 4 });
    const inviteBody = bodies.find((b) => !b.includes('"opener"'))!;
    const sent = JSON.parse(inviteBody).messages[1].content as string;
    expect(sent).toMatch(/HOOK: Kunden können den Shop[^\n]*WhatsApp/);
    expect(sent).toMatch(/ANGLE: a support chat/);
    expect(sent).not.toMatch(/NO_CHAT_WIDGET|kein Chat/i);
    const q = await row(7301);
    expect(q.error).toBeNull();
    expect(q.message_text).toBe(`Guten Tag Ralf,\n\n${NOTE}`);
    expect(q.personalization).toMatchObject({
      hook: 'SUPPORT_WHATSAPP',
      angle: 'support',
      platform: 'Shopify',
    });
  });

  it('holds back a note that skips the fact, sounds like an audit or invents a number', async () => {
    note =
      'Ich habe Ihre Website analysiert und baue Support-Chats für Online-Shops mit über 300 Anfragen am Tag, gern tausche ich mich aus.';
    await prepare();
    const q = await row(7301);
    expect(q.status).toBe('proposed');
    expect(q.error).toMatch(/audit/);
    expect(q.error).toMatch(/number that was not given \(300\)/);
    expect(q.error).toMatch(/does not mention the chosen fact \(SUPPORT_WHATSAPP\)/);
  });

  it('puts an opening into the first message only, and only with a usable fact', async () => {
    await prepare();
    const first = await row(7302);
    expect(first.message_text).toBe(insertOpener(MSG1, OPENER));
    expect(
      first.message_text.startsWith(
        'Guten Tag Rita, danke für die Vernetzung.\n\nMir ist aufgefallen',
      ),
    ).toBe(true);
    expect(first.personalization).toMatchObject({ hook: 'SUPPORT_WHATSAPP', angle: 'support' });
    // a company without signals: the campaign text unchanged, counted as "none"
    const plain = await row(7303);
    expect(plain.message_text).toBe(MSG1);
    expect(plain.personalization).toEqual({ hook: 'none' });
    // the second message is never touched
    const second = await row(7304);
    expect(second.message_text).toBe('Guten Tag Rita, kurz etwas Konkretes dazu.');
    expect(second.personalization).toBeNull();
    expect(bodies.filter((b) => b.includes('"opener"')).length).toBe(1);
  });

  it('sends the campaign text unchanged when the opening fails a check', async () => {
    opener = 'Ich habe Ihren Shop analysiert, wollen wir telefonieren?';
    await prepare();
    const first = await row(7302);
    expect(first.message_text).toBe(MSG1);
    expect(first.error).toBeNull();
    expect(first.personalization).toEqual({ hook: 'none' });
  });

  it('reports how each opening did', async () => {
    await prepare();
    await owner((c) =>
      c.query(`update outreach.action_queue set status = 'done', executed_at = now() - interval '2 days' where id in (7301, 7302, 7303);
               update outreach.prospects set accepted_at = now() where id = 9301;
               update outreach.prospects set replied_at = now() where id = 9302`),
    );
    const stats = (
      await app.inject({ method: 'GET', url: '/panel/message-stats', headers: auth() })
    ).json();
    expect(stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'invite', hook: 'SUPPORT_WHATSAPP', sent: 1, accepted: 1 }),
        expect.objectContaining({
          kind: 'first_message',
          hook: 'SUPPORT_WHATSAPP',
          sent: 1,
          replied: 1,
        }),
        expect.objectContaining({ kind: 'first_message', hook: 'none', sent: 1, replied: 0 }),
      ]),
    );
  });
});
