import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let notes: { index: number; note: string }[] = [];
let failAi = false;
const fetchMock = vi.fn<FetchLike>(async () =>
  failAi
    ? new Response('boom', { status: 500 })
    : new Response(
        JSON.stringify({
          model: 'anthropic/claude-sonnet-5.5',
          choices: [{ message: { content: JSON.stringify({ notes }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 800, completion_tokens: 200, cost: 0.01 },
        }),
      ),
);
const { app, db } = await makeApp(fetchMock);
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
const auth = () => ({ authorization: `Bearer ${token}` });

const GOOD =
  'Ihr Weg zum eigenen Maklerbuero Bittner hat mich interessiert. Ich baue KI-Agenten für Maklerbüros und tausche mich gern mit Inhabern aus.';
const prepare = () =>
  app
    .inject({ method: 'POST', url: '/panel/queue/prepare', headers: auth() })
    .then((r) => r.json());
const row = (id: number) =>
  owner((c) =>
    c.query(
      `select status, approved_via, error, message_text from outreach.action_queue where id = $1`,
      [id],
    ),
  ).then((r) => r.rows[0]);

beforeEach(async () => {
  fetchMock.mockClear();
  failAi = false;
  notes = [{ index: 0, note: GOOD }];
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
    await c.query(`insert into outreach.settings (key, value, note) values ('auto_approve', 'false', 't')
                   on conflict (key) do update set value = 'false'`);
    await c.query(`update outreach.settings set value = 'true' where key = 'ext_dry_run'`);
    await c.query(`delete from outreach.campaigns where id = 'test-camp'`);
    await c.query(
      `insert into outreach.campaigns (id, name, status) values ('test-camp', 'Test', 'on')`,
    );
    const camp = 'test-camp';
    await c.query(
      `insert into outreach.prospects (id, linkedin_url, full_name, first_name, headline, company, stage, campaign_id, raw) values
        (9201, 'https://www.linkedin.com/in/hans-b/', 'Hans Bittner', 'Hans', 'Geschäftsführender Inhaber bei Maklerbuero Bittner', 'Maklerbuero Bittner', 'approved', $1,
         '{"fit":{"status":"yes","evidence":["Geschäftsführender Inhaber bei Maklerbuero Bittner"]}}'),
        (9202, 'https://www.linkedin.com/in/reply-r/', 'Reply Person', 'Reply', 'Makler', 'X GmbH', 'replied', $1, '{}')`,
      [camp],
    );
    await c.query(
      `insert into outreach.action_queue (id, prospect_id, campaign_id, action, message_text, due_at, status) values
        (7201, 9201, $1, 'connect', 'Guten Tag Hans, Vorlage: Wie viele Stunden gehen bei Ihnen drauf?', now() - interval '12 days', 'scheduled'),
        (7202, 9202, $1, 'connect', 'Vorlage', now() - interval '1 day', 'scheduled'),
        (7203, 9201, $1, 'reply', 'Antwort', now() - interval '1 day', 'scheduled')`,
      [camp],
    );
  });
});

describe('prepare step', () => {
  it('writes a personal invite note and puts it in the Approve tab when auto_approve is off', async () => {
    const r = await prepare();
    expect(r).toMatchObject({ candidates: 1, approved: 0, proposed: 1 });
    const q = await row(7201);
    expect(q.status).toBe('proposed');
    expect(q.error).toBeNull();
    // ordinary words get their umlauts back ("Maklerbuero" copied from the company name)
    expect(q.message_text).toBe(`Guten Tag Hans,\n\n${GOOD.replace('Maklerbuero', 'Maklerbüro')}`);
    // never touched: someone who replied, and replies
    expect((await row(7202)).status).toBe('scheduled');
    expect((await row(7203)).status).toBe('scheduled');
    // the AI got the facts as fenced data
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1]
      .content as string;
    expect(sent).toMatch(/<page_data>[\s\S]*Maklerbuero Bittner/);
    const list = (await app.inject({ method: 'GET', url: '/panel/queue', headers: auth() })).json();
    expect(list.map((x: { id: number }) => x.id)).toContain(7201);
  });

  it('gives the AI the approved voice profile, and nothing about voice without one', async () => {
    await prepare();
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1].content;
    expect(first).not.toMatch(/JIBRAN'S VOICE/);

    await owner(async (c) => {
      await c.query('delete from outreach.voice_profiles');
      await c.query(
        `insert into outreach.voice_profiles (status, approved_at, samples, fingerprint, profile, better)
         values ('approved', now(), '{}', '{}', $1, $2)`,
        [
          JSON.stringify({
            summary: 'Sachlich, kurz, aus der Praxis.',
            languages: 'Deutsch',
            address_form: 'Sie',
            tone: 'ruhig',
            rhythm: 'kurze Sätze',
            phrases: [],
            avoids: ['Superlative'],
            comment_style: 'konkret',
            signature_lines: [],
            story_bank: [],
          }),
          JSON.stringify({ rules: ['Ein Gedanke pro Satz'] }),
        ],
      );
      await c.query(
        `update outreach.action_queue set status = 'scheduled', message_text = 'Vorlage' where id = 7201`,
      );
    });
    fetchMock.mockClear();
    await prepare();
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1].content;
    expect(sent).toMatch(
      /JIBRAN'S VOICE[\s\S]*Sachlich, kurz, aus der Praxis[\s\S]*He avoids: Superlative/,
    );
    await owner((c) => c.query('delete from outreach.voice_profiles'));
  });

  it('writes for the campaign audience and builds the salutation from the full name when no first name is stored', async () => {
    await owner(async (c) => {
      await c.query(`delete from outreach.campaigns where id = 'shop-camp'`);
      await c.query(
        `insert into outreach.campaigns (id, name, description, status) values
         ('shop-camp', 'E-Commerce Support', 'Shopbetreiber (Shopify, Shopware) | Sie-Form | OFF bis Freigabe', 'on')`,
      );
      await c.query(
        `insert into outreach.prospects (id, linkedin_url, full_name, first_name, headline, company, stage, campaign_id, raw) values
          (9211, 'https://www.linkedin.com/in/rolf-s/', 'Rolf Schenk', null, 'Geschäftsführer bei laufsport-beispiel.de GmbH', 'laufsport-beispiel.de GmbH', 'approved', 'shop-camp',
           '{"fit":{"status":"yes","evidence":["Geschäftsführer bei laufsport-beispiel.de GmbH"]}}'),
          (9212, 'https://www.linkedin.com/in/kai-w/', 'Dr. Kurt Wendler', null, 'Geschäftsführer bei laufsport-beispiel.de GmbH', 'laufsport-beispiel.de GmbH', 'approved', 'shop-camp',
           '{"fit":{"status":"yes","evidence":["Geschäftsführer bei laufsport-beispiel.de GmbH"]}}')`,
      );
      await c.query(
        `insert into outreach.action_queue (id, prospect_id, campaign_id, action, message_text, due_at, status) values
          (7211, 9211, 'shop-camp', 'connect', 'Vorlage', now() - interval '1 day', 'scheduled'),
          (7212, 9212, 'shop-camp', 'connect', 'Vorlage', now() - interval '1 day', 'scheduled')`,
      );
    });
    // the broker prospect of the default campaign is not part of this test
    await owner((c) =>
      c.query(`update outreach.action_queue set status = 'cancelled' where id = 7201`),
    );
    notes = [
      {
        index: 0,
        note: 'Ich baue KI-Agenten für Online-Shops und tausche mich gern mit Inhabern aus. Als Geschäftsführer von laufsport-beispiel.de passen Sie gut dazu.',
      },
      {
        index: 1,
        note: 'Ich baue KI-Agenten für Online-Shops und tausche mich gern mit Inhabern aus. Ihr Shop laufsport-beispiel.de hat mein Interesse geweckt.',
      },
    ];
    await prepare();
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1]
      .content as string;
    expect(sent).toMatch(
      /AUDIENCE \(the campaign\): E-Commerce Support: Shopbetreiber \(Shopify, Shopware\)/,
    );
    expect(sent).not.toMatch(/OFF bis Freigabe/);
    expect((await row(7211)).message_text).toMatch(/^Guten Tag Rolf,\n\n/);
    expect((await row(7212)).message_text).toMatch(/^Guten Tag Kurt,\n\n/);
  });

  it('puts old invitations in Approve (never auto-approved) and caps withdrawals at 12 a day', async () => {
    await owner(async (c) => {
      await c.query(`update outreach.settings set value = 'true' where key = 'auto_approve'`);
      await c.query(`delete from outreach.campaigns where id = 'old-camp'`);
      await c.query(
        `insert into outreach.campaigns (id, name, status) values ('old-camp', 'Old', 'archived')`,
      );
      await c.query(
        `insert into outreach.prospects (id, linkedin_url, full_name, first_name, stage, campaign_id, invited_at) values
          (9221, 'https://www.linkedin.com/in/old-one/', 'Old One', 'Old', 'invited', 'old-camp', now() - interval '70 days')`,
      );
      await c.query(
        `insert into outreach.action_queue (id, prospect_id, campaign_id, action, due_at, status) values
          (7221, 9221, 'old-camp', 'withdraw', now() - interval '2 days', 'scheduled')`,
      );
    });
    await prepare();
    expect((await row(7221)).status).toBe('proposed'); // even with auto_approve on
    expect((await row(7201)).status).toBe('approved'); // the invite is still approved by itself

    // ...and the send batch hands out at most 12 withdrawals a day
    await owner(async (c) => {
      await c.query(`update outreach.settings set value = 'false' where key = 'ext_dry_run'`);
      for (let i = 0; i < 14; i++) {
        await c.query(
          `insert into outreach.prospects (id, linkedin_url, full_name, stage, campaign_id, invited_at) values ($1, $2, $3, 'invited', 'old-camp', now() - interval '70 days')`,
          [9300 + i, `https://www.linkedin.com/in/w-${i}/`, `W ${i}`],
        );
        await c.query(
          `insert into outreach.action_queue (id, prospect_id, campaign_id, action, due_at, status, approved_at) values ($1, $2, 'old-camp', 'withdraw', now() - interval '1 day', 'approved', now())`,
          [7300 + i, 9300 + i],
        );
      }
      // 8 withdrawals were already done today
      for (let i = 0; i < 8; i++)
        await c.query(
          `insert into outreach.events (event_type, ok, detail) values ('invite_withdrawn', true, '{}')`,
        );
    });
    const batch = (
      await app.inject({ method: 'GET', url: '/ext/send/batch?max=10', headers: auth() })
    ).json();
    const w = batch.items.filter((x: { action: string }) => x.action === 'withdraw');
    expect(w).toHaveLength(4); // 12 - 8
  });

  it('approves by itself with auto_approve on, and the invite is then sendable even though it was due long ago', async () => {
    await owner((c) =>
      c.query(`update outreach.settings set value = 'true' where key = 'auto_approve'`),
    );
    expect(await prepare()).toMatchObject({ approved: 1, proposed: 0 });
    expect(await row(7201)).toMatchObject({ status: 'approved', approved_via: 'auto' });
    const batch = (
      await app.inject({ method: 'GET', url: '/ext/send/batch?max=5', headers: auth() })
    ).json();
    expect(batch.items.map((i: { id: number }) => i.id)).toContain(7201);
  });

  it('never auto-approves a note that fails a check: it waits with the reason', async () => {
    await owner((c) =>
      c.query(`update outreach.settings set value = 'true' where key = 'auto_approve'`),
    );
    notes = [
      {
        index: 0,
        note: 'Wie viele Stunden pro Woche verbringen Sie bei Maklerbuero Bittner mit Verwaltung?',
      },
    ];
    expect(await prepare()).toMatchObject({ approved: 0, proposed: 1 });
    const q = await row(7201);
    expect(q.status).toBe('proposed');
    expect(q.error).toMatch(/needs a look: .*(hours|time)/);
  });

  it('requires a concrete fact about the person', async () => {
    await owner((c) =>
      c.query(`update outreach.settings set value = 'true' where key = 'auto_approve'`),
    );
    notes = [
      {
        index: 0,
        note: 'Ich baue KI-Agenten für Maklerbüros und tausche mich gern mit Inhabern aus.',
      },
    ];
    await prepare();
    const q = await row(7201);
    expect(q.status).toBe('proposed');
    expect(q.error).toMatch(/anything specific about the person/);
  });

  it('leaves the row scheduled when the AI is unavailable, and tries again next time', async () => {
    failAi = true;
    expect(await prepare()).toMatchObject({ candidates: 1, approved: 0, proposed: 0, deferred: 1 });
    expect((await row(7201)).status).toBe('scheduled');
    failAi = false;
    expect(await prepare()).toMatchObject({ proposed: 1 });
  });

  it('skips campaigns that are off', async () => {
    await owner((c) =>
      c.query(`update outreach.campaigns set status = 'off' where id = 'test-camp'`),
    );
    expect(await prepare()).toMatchObject({ candidates: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can be switched on from the settings route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/panel/settings/auto_approve',
      headers: auth(),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(200);
    const all = (
      await app.inject({ method: 'GET', url: '/panel/settings', headers: auth() })
    ).json();
    expect(all.auto_approve.value).toBe(true);
  });
});
