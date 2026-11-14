import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});

let queueId = 0;
let candidateId = 0;
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
    await c.query(`delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects;
                   delete from outreach.candidates; delete from outreach.engagement; delete from outreach.campaign_actions;
                   delete from outreach.campaigns`);
    await c.query(`insert into outreach.campaigns (id, name, status) values ('pc', 'Panel', 'on')`);
    await c.query(`insert into outreach.campaign_actions (campaign_id, step, action_type, text, delay)
                   values ('pc', 1, 'connect', 'Hallo _FN_', '0')`);
    // Approving a prospect makes the triggers queue the connect; the robot would then propose it.
    const p =
      await c.query(`insert into outreach.prospects (linkedin_url, first_name, full_name, campaign_id, stage)
                             values ('https://www.linkedin.com/in/p-one/', 'Paula', 'Paula One', 'pc', 'approved') returning id`);
    const q = await c.query(
      `update outreach.action_queue set status = 'proposed',
                             message_text = 'Guten Tag Paula, Ihr Beitrag zur DKM hat mich angesprochen. Ich vernetze mich gern.'
                             where prospect_id = $1 returning id`,
      [p.rows[0].id],
    );
    queueId = Number(q.rows[0].id);
    const cand =
      await c.query(`insert into outreach.candidates (full_name, headline, linkedin_url, verdict, campaign_id, reason)
                                values ('Lena Lead', 'Versicherungsmaklerin', 'https://www.linkedin.com/in/lena-lead/?trk=x', 'staged', 'pc', 'broker')
                                returning id`);
    candidateId = Number(cand.rows[0].id);
    await c.query(
      `insert into outreach.engagement (post_urn, author_name, comment_draft) values ('urn:li:activity:1', 'Autor', 'Guter Punkt.')`,
    );
  });
});

const h = () => ({ authorization: `Bearer ${token}`, 'x-extension-version': '0.1.0' });
const get = (url: string) => app.inject({ method: 'GET', url, headers: h() });
const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: h(), payload });

describe('side panel', () => {
  it('works for the web app (no extension header) but refuses an outdated extension', async () => {
    const web = await app.inject({
      method: 'GET',
      url: '/panel/dashboard',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(web.statusCode).toBe(200);
    const old = await app.inject({
      method: 'GET',
      url: '/panel/dashboard',
      headers: { authorization: `Bearer ${token}`, 'x-extension-version': '0.0.1' },
    });
    expect(old.statusCode).toBe(426);
  });

  it('dashboard counts what waits for Jibran', async () => {
    const d = (await get('/panel/dashboard')).json();
    expect(d.counts).toMatchObject({ approve: 1, leads: 1, comments: 1 });
    expect(d.limits.invite_status).toBeDefined();
  });

  it('approves a clean note without sending anything', async () => {
    const res = await post(`/panel/queue/${queueId}`, { decision: 'approve' });
    expect(res.statusCode).toBe(200);
    const row = await owner((c) =>
      c.query('select status, approved_via, executed_at from outreach.action_queue where id = $1', [
        queueId,
      ]),
    );
    expect(row.rows[0]).toMatchObject({
      status: 'approved',
      approved_via: 'extension',
      executed_at: null,
    });
  });

  it('refuses to approve an edited text that breaks the rules', async () => {
    const res = await post(`/panel/queue/${queueId}`, {
      decision: 'approve',
      text: 'Hey du, in einer geschäftigen Stadt wie Berlin 👋',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors.join(' ')).toMatch(/banned phrases.*du-form|du-form/s);
    const row = await owner((c) =>
      c.query('select status from outreach.action_queue where id = $1', [queueId]),
    );
    expect(row.rows[0].status).toBe('proposed');
  });

  it('lets a reply mirror the du-form but still blocks banned phrases', async () => {
    const r = await owner(async (c) => {
      const p =
        await c.query(`insert into outreach.prospects (linkedin_url, first_name, full_name, campaign_id, stage)
                               values ('https://www.linkedin.com/in/p-two/', 'Sam', 'Sam Two', 'pc', 'replied') returning id`);
      return c.query(
        `insert into outreach.action_queue (prospect_id, campaign_id, action, status, message_text)
                      values ($1, 'pc', 'reply', 'proposed', 'x') returning id`,
        [p.rows[0].id],
      );
    });
    const id = Number(r.rows[0].id);
    expect(
      (
        await post(`/panel/queue/${id}`, {
          decision: 'approve',
          text: 'Hallo Sam, danke dir, schreib mir einfach, wann es passt.',
        })
      ).statusCode,
    ).toBe(200);
    await owner((c) =>
      c.query(`update outreach.action_queue set status = 'proposed' where id = $1`, [id]),
    );
    expect(
      (
        await post(`/panel/queue/${id}`, {
          decision: 'approve',
          text: 'Das ist nur eine Vorlage für dich.',
        })
      ).statusCode,
    ).toBe(422);
  });

  it('reject cancels the row', async () => {
    await post(`/panel/queue/${queueId}`, { decision: 'reject' });
    const row = await owner((c) =>
      c.query('select status from outreach.action_queue where id = $1', [queueId]),
    );
    expect(row.rows[0].status).toBe('cancelled');
  });

  it('approving a lead enrolls the prospect, and the triggers queue step 1 as scheduled', async () => {
    const res = await post(`/panel/leads/${candidateId}`, { decision: 'approve' });
    expect(res.json()).toMatchObject({ verdict: 'approved' });
    const p = await owner((c) =>
      c.query(`select p.stage, p.first_name, q.action, q.status from outreach.prospects p
               join outreach.action_queue q on q.prospect_id = p.id where p.linkedin_url = 'https://www.linkedin.com/in/lena-lead/'`),
    );
    expect(p.rows[0]).toEqual({
      stage: 'approved',
      first_name: 'Lena',
      action: 'connect',
      status: 'scheduled',
    });
    // a second approval of the same person is recorded as duplicate
    await owner((c) =>
      c.query(`update outreach.candidates set verdict = 'staged' where id = $1`, [candidateId]),
    );
    expect(
      (await post(`/panel/leads/${candidateId}`, { decision: 'approve' })).json().verdict,
    ).toBe('duplicate');
  });

  it('comment approval checks the text and never posts', async () => {
    const id = (await get('/panel/comments')).json()[0].id;
    expect(
      (await post(`/panel/comments/${id}`, { decision: 'approve', text: 'Siehe www.example.com' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await post(`/panel/comments/${id}`, {
          decision: 'approve',
          text: 'Guter Punkt, gerade beim Schadenprozess.',
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(`/panel/comments/${id}`, { decision: 'posted' })).statusCode).toBe(200);
    const row = await owner((c) =>
      c.query(
        'select status, posted_at is not null as posted from outreach.engagement where id = $1',
        [id],
      ),
    );
    expect(row.rows[0]).toEqual({ status: 'posted', posted: true });
  });

  it('activity lists events with the prospect name, and runs', async () => {
    await owner(async (c) => {
      await c.query(`insert into outreach.events (prospect_id, event_type, detail)
                     select id, 'accepted', '{"note":"via test"}' from outreach.prospects where first_name = 'Paula'`);
      await c.query(
        `insert into outreach.runs (kind, status, notes) values ('robot', 'ok', 'test run')`,
      );
    });
    const a = (await get('/panel/activity')).json() as {
      kind: string;
      type: string;
      full_name: string | null;
      note: string;
    }[];
    expect(a).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'event',
          type: 'accepted',
          full_name: 'Paula One',
          note: 'via test',
        }),
        expect.objectContaining({ kind: 'run', type: 'robot', note: 'test run' }),
      ]),
    );
  });

  it('capture endpoint is off unless DEV_CAPTURE_DIR is set', async () => {
    const res = await post('/panel/dev/capture', { kind: 'profile', lang: 'en', html: '<p>x</p>' });
    expect(res.statusCode).toBe(404);
  });
});
