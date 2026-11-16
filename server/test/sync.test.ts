import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  await owner((c) =>
    c.query(`delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects;
      insert into outreach.prospects (id, linkedin_url, full_name, stage, invited_at) values
        (9001, 'https://www.linkedin.com/in/anna-muster/', 'Anna Muster', 'invited', now() - interval '9 days'),
        (9002, 'https://www.linkedin.com/in/ben-reply/', 'Ben Reply', 'msg1_sent', now() - interval '9 days')`),
  );
  await owner((c) =>
    c.query(`update outreach.prospects set msg1_at = now() - interval '3 days' where id = 9002`),
  );
});

describe('sync round', () => {
  it('marks accepted and replied prospects and stores the pending count', async () => {
    const day = (d: number) => new Date(Date.now() - d * 86_400_000);
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const r = await app.inject({
      method: 'POST',
      url: '/ext/sync',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        jobId: null,
        connections: [
          {
            name: 'Anna Muster',
            profileUrl: 'https://www.linkedin.com/in/anna-muster/',
            connectedOn: day(1).toISOString().slice(0, 10),
          },
        ],
        sent: { total: 290, items: [] },
        received: [],
        inbox: [
          {
            name: 'Ben Reply',
            snippet: 'Klingt spannend, rufen Sie mich an',
            fromMe: false,
            unread: true,
            time: fmt(day(1)),
            sponsored: false,
          },
          {
            name: 'Someone Else',
            snippet: 'Hallo',
            fromMe: false,
            unread: true,
            time: fmt(day(1)),
            sponsored: false,
          },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      accepted: 1,
      replied: 1,
      pending: 290,
      acceptedNames: ['Anna Muster'],
      repliedNames: ['Ben Reply'],
    });
    const rows = await owner((c) =>
      c.query('select id::int as id, stage, reply_snippet from outreach.prospects order by id'),
    );
    expect(rows.rows).toEqual([
      { id: 9001, stage: 'accepted', reply_snippet: null },
      { id: 9002, stage: 'replied', reply_snippet: 'Klingt spannend, rufen Sie mich an' },
    ]);
    const lim = await owner((c) => c.query('select outreach.limits() l'));
    expect(lim.rows[0].l.pending_invites_linkedin).toBe(290);
  });
});

describe('send round', () => {
  const h = () => ({ authorization: `Bearer ${token}` });
  const seed = (sql: string) => owner((c) => c.query(sql));
  it('hands out only due, recent, approved items; practice results change nothing; live is refused in dry run', async () => {
    await seed(`
      insert into outreach.settings (key, value) values ('ext_dry_run','true'), ('paused','false'),
        ('robot_schedule', '{"0":[["00:00","23:59"]],"1":[["00:00","23:59"]],"2":[["00:00","23:59"]],"3":[["00:00","23:59"]],"4":[["00:00","23:59"]],"5":[["00:00","23:59"]],"6":[["00:00","23:59"]]}')
        on conflict (key) do update set value = excluded.value;
      update outreach.prospects set stage = 'accepted' where id = 9001;
      insert into outreach.prospects (id, linkedin_url, full_name, stage) values (9003, 'https://www.linkedin.com/in/old-one/', 'Old One', 'accepted');
      insert into outreach.action_queue (id, prospect_id, action, message_text, due_at, status) values
        (7001, 9001, 'message', 'Guten Tag Anna, kurze Frage.', now() - interval '1 hour', 'approved'),
        (7002, 9003, 'message', 'Alt', now() - interval '30 days', 'approved'),
        (7003, 9002, 'message', 'An jemanden, der geantwortet hat', now() - interval '1 hour', 'proposed')`);
    const b = (
      await app.inject({ method: 'GET', url: '/ext/send/batch?max=5', headers: h() })
    ).json();
    expect(b.practice).toBe(true);
    expect(b.items.map((i: { id: number }) => Number(i.id))).toEqual([7001]);
    expect(b.stale).toBe(1);
    const res = (practice: boolean) =>
      app.inject({
        method: 'POST',
        url: '/ext/send/7001/result',
        headers: h(),
        payload: { practice, ok: true, note: 'typed', detail: {} },
      });
    expect((await res(true)).statusCode).toBe(200);
    const q = await owner((c) =>
      c.query('select status from outreach.action_queue where id = 7001'),
    );
    expect(q.rows[0].status).toBe('approved');
    expect((await res(false)).statusCode).toBe(400); // dry run is on
    // outside the send window nothing is handed out
    await seed(`update outreach.settings set value = '{}' where key = 'robot_schedule'`);
    const closed = (
      await app.inject({ method: 'GET', url: '/ext/send/batch', headers: h() })
    ).json();
    expect(closed).toMatchObject({ window_open: false, items: [] });
  });
  it("live batches hand out no more invites than today's target", async () => {
    await seed(`
      insert into outreach.settings (key, value) values ('ext_dry_run','false'), ('paused','false'),
        ('daily_invite_cap','20'), ('weekly_invite_cap','7'), ('pending_invite_cap','500'),
        ('robot_schedule', '{"0":[["00:00","23:59"]],"1":[["00:00","23:59"]],"2":[["00:00","23:59"]],"3":[["00:00","23:59"]],"4":[["00:00","23:59"]],"5":[["00:00","23:59"]],"6":[["00:00","23:59"]]}')
        on conflict (key) do update set value = excluded.value;
      delete from outreach.settings where key in ('linkedin_pending_invites', 'linkedin_limit_alert', 'invites_paused_until');
      insert into outreach.prospects (id, linkedin_url, full_name, stage)
        select 9100 + g, 'https://www.linkedin.com/in/lead-' || g || '/', 'Lead ' || g, 'approved' from generate_series(1, 4) g;
      insert into outreach.action_queue (prospect_id, action, message_text, due_at, status)
        select 9100 + g, 'connect', 'Hallo', now() - interval '1 hour', 'approved' from generate_series(1, 4) g`);
    // 7 per week over 7 send days = 1 a day (1.2 at most rounds to 1)
    const b = (
      await app.inject({ method: 'GET', url: '/ext/send/batch?max=6', headers: h() })
    ).json();
    expect(b.practice).toBe(false);
    expect(b.invite_day_target).toBe(1);
    expect(b.items.filter((i: { action: string }) => i.action === 'connect')).toHaveLength(1);
  });
});
