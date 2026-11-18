import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

// English campaigns (UK and Europe, 18.11.2026). Own file: the login route allows 10 logins per
// 15 minutes, and prepare.test.ts logs in before each of its tests. Names invented.
let notes: { index: number; note: string }[] = [];
const fetchMock = vi.fn<FetchLike>(
  async () =>
    new Response(
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
const prepare = () =>
  app
    .inject({ method: 'POST', url: '/panel/queue/prepare', headers: auth() })
    .then((r) => r.json());
const row = (id: number) =>
  owner((c) =>
    c.query(`select status, error, message_text from outreach.action_queue where id = $1`, [id]),
  ).then((r) => r.rows[0]);

beforeEach(async () => {
  fetchMock.mockClear();
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
  });
});

describe('prepare step, English campaigns', () => {
  it('English campaigns: "Hi <name>,", the English prompt, no German checks (18.11.2026)', async () => {
    await owner(async (c) => {
      await c.query(`delete from outreach.campaigns where id = 'uk-camp'`);
      await c.query(
        `insert into outreach.campaigns (id, name, description, status, language) values
         ('uk-camp', 'Shops UK', 'Online shop owners in the UK | free support check', 'on', 'en')`,
      );
      await c.query(
        `insert into outreach.prospects (id, linkedin_url, full_name, first_name, headline, company, stage, campaign_id, raw) values
          (9221, 'https://www.linkedin.com/in/olivia-uk/', 'Olivia Example', 'Olivia', 'Founder at Teapot Goods Ltd', 'Teapot Goods Ltd', 'approved', 'uk-camp',
           '{"fit":{"status":"yes","evidence":["Founder at Teapot Goods Ltd"]}}')`,
      );
      await c.query(
        `insert into outreach.action_queue (id, prospect_id, campaign_id, action, message_text, due_at, status) values
          (7221, 9221, 'uk-camp', 'connect', 'Template', now() - interval '1 day', 'scheduled')`,
      );
    });
    notes = [
      {
        index: 0,
        note: 'You run Teapot Goods Ltd, selling tea gear online. I build AI agents for online shops and would be glad to connect.',
      },
    ];
    await prepare();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.response_format.json_schema.name).toBe('invite_note_en');
    const q = await row(7221);
    expect(q.message_text).toBe(
      'Hi Olivia,\n\nYou run Teapot Goods Ltd, selling tea gear online. I build AI agents for online shops and would be glad to connect.',
    );
    expect(q.status).toBe('proposed');
    expect(q.error).toBeNull();
  });
});
