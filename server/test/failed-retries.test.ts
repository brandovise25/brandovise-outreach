import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
const auth = () => ({ authorization: `Bearer ${token}` });
const fail = (id: number) =>
  app.inject({
    method: 'POST',
    url: `/ext/send/${id}/result`,
    headers: auth(),
    payload: { practice: false, ok: false, note: 'The invite dialog did not open.', detail: {} },
  });
const stage = (id: number) =>
  owner((c) => c.query('select stage from outreach.prospects where id = $1', [id])).then(
    (r) => r.rows[0].stage,
  );

beforeEach(async () => {
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
      `delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects;
       delete from outreach.campaigns where id = 'retry-camp';
       insert into outreach.campaigns (id, name, status) values ('retry-camp', 'Retry', 'on');
       update outreach.settings set value = 'false' where key = 'ext_dry_run';
       insert into outreach.prospects (id, linkedin_url, full_name, stage, campaign_id) values
         (9301, 'https://www.linkedin.com/in/stuck/', 'Stuck Person', 'approved', 'retry-camp'),
         (9302, 'https://www.linkedin.com/in/fresh/', 'Fresh Person', 'approved', 'retry-camp');
       update outreach.prospects set stage = 'approved' where id in (9301, 9302);
       delete from outreach.action_queue;
       insert into outreach.action_queue (id, prospect_id, campaign_id, action, message_text, due_at, status) values
         (7301, 9301, 'retry-camp', 'connect', 'a', now() - interval '3 days', 'failed'),
         (7302, 9301, 'retry-camp', 'connect', 'b', now() - interval '2 days', 'failed'),
         (7303, 9301, 'retry-camp', 'connect', 'c', now() - interval '1 hour', 'approved'),
         (7304, 9302, 'retry-camp', 'connect', 'd', now() - interval '1 hour', 'approved')`,
    );
  });
});

describe('failed sends do not loop', () => {
  it('stops a person after the second failure and closes what is open', async () => {
    expect((await fail(7303)).statusCode).toBe(200);
    expect(await stage(9301)).toBe('skipped');
    const open = await owner((c) =>
      c.query(
        `select count(*) n from outreach.action_queue where prospect_id = 9301 and status in ('scheduled','proposed','approved')`,
      ),
    );
    expect(Number(open.rows[0].n)).toBe(0);
    const ev = await owner((c) =>
      c.query(
        `select detail->>'reason' r from outreach.events where prospect_id = 9301 and event_type = 'skipped'`,
      ),
    );
    expect(ev.rows[0].r).toMatch(/sending failed 3 times: The invite dialog did not open/);
  });

  it('keeps a person with a single failure in the queue', async () => {
    expect((await fail(7304)).statusCode).toBe(200);
    expect(await stage(9302)).toBe('approved');
  });
});

describe('results for rows moved while a round held them (14.11.2026)', () => {
  const result = (id: number, ok: boolean) =>
    app.inject({
      method: 'POST',
      url: `/ext/send/${id}/result`,
      headers: auth(),
      payload: { practice: false, ok, note: ok ? 'Invitation sent' : 'failed', detail: {} },
    });
  it('records a sent invite even after the row was set back, and ignores a failure there', async () => {
    await owner((c) =>
      c.query(`update outreach.action_queue set status = 'scheduled' where id in (7303, 7304)`),
    );
    expect((await result(7304, true)).statusCode).toBe(200);
    expect(await stage(9302)).toBe('invited');
    const row = await owner((c) =>
      c.query(`select status from outreach.action_queue where id = 7304`),
    );
    expect(row.rows[0].status).toBe('done');
    expect((await result(7303, false)).json()).toMatchObject({ ignored: 'scheduled' });
    expect(await stage(9301)).toBe('approved');
  });
});
