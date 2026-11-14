import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
const API = { 'x-api-token': 'test-api-token-0123456789abcdef0123456789' };
let token = '';
let approvedId = 0;
let draftId = 0;
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
  [approvedId, draftId] = await owner(async (c) => {
    await c.query('delete from outreach.ext_jobs; delete from outreach.engagement');
    await c.query(
      `delete from outreach.settings where key in ('comment_autopost','comment_posting_live','comment_autopost_next','job_next_after')`,
    );
    // Jobs may start at any hour in tests.
    await c.query(
      `insert into outreach.settings (key, value) values ('job_hours', '{"from":0,"to":24}') on conflict (key) do update set value = excluded.value`,
    );
    // No pause between jobs in tests, except where a test sets one.
    await c.query(
      `insert into outreach.settings (key, value) values ('job_gap_seconds', '{"min":0,"max":0}') on conflict (key) do update set value = excluded.value`,
    );
    const a = await c.query(
      `insert into outreach.engagement (post_key, comment_draft, status, reviewed_at) values ('a', 'x', 'approved', now()) returning id`,
    );
    const d = await c.query(
      `insert into outreach.engagement (post_key, comment_draft, status) values ('d', 'y', 'drafted') returning id`,
    );
    return [Number(a.rows[0].id), Number(d.rows[0].id)];
  });
});

const h = () => ({ authorization: `Bearer ${token}` });
const claim = () =>
  app.inject({ method: 'POST', url: '/ext/jobs/claim', headers: h(), payload: {} });
const enqueue = (
  payload: Record<string, unknown>,
  headers: Record<string, string> = h(),
  url = '/panel/jobs',
) => app.inject({ method: 'POST', url, headers, payload });
const setting = (k: string, v: string) =>
  owner((c) =>
    c.query(
      `insert into outreach.settings (key, value) values ($1, $2) on conflict (key) do update set value = $2`,
      [k, v],
    ),
  );

describe('job queue', () => {
  it('runs one job at a time, in order', async () => {
    await enqueue({ kind: 'capture_sync' });
    await enqueue({ kind: 'comment_round' });
    const first = (await claim()).json().job;
    expect(first.kind).toBe('capture_sync');
    // (a second claim from the same device would close the first job as cut off)
    await app.inject({
      method: 'POST',
      url: `/ext/jobs/${first.id}/finish`,
      headers: h(),
      payload: { status: 'done', result: { note: 'ok' } },
    });
    expect((await claim()).json().job.kind).toBe('comment_round');
  });

  it('refuses to queue a post for a comment that is not approved', async () => {
    expect((await enqueue({ kind: 'post_comment', params: { id: draftId } })).statusCode).toBe(400);
    expect((await enqueue({ kind: 'post_comment', params: { id: approvedId } })).statusCode).toBe(
      200,
    );
  });
});

describe('auto-post planner', () => {
  it('does nothing in practice mode or when switched off', async () => {
    await setting('comment_autopost', 'true');
    expect((await claim()).json().job).toBeNull(); // live mode is off
    await setting('comment_autopost', 'false');
    await setting('comment_posting_live', 'true');
    expect((await claim()).json().job).toBeNull(); // auto-post off
  });

  it('posts approved comments only, then waits 30-90 minutes', async () => {
    await setting('comment_autopost', 'true');
    await setting('comment_posting_live', 'true');
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    if (hour < 7 || hour >= 21) return; // the planner only works 07-21 Berlin
    const job = (await claim()).json().job;
    expect(job).toMatchObject({
      kind: 'post_comment',
      params: { id: approvedId },
      created_by: 'autopost',
    });
    await app.inject({
      method: 'POST',
      url: `/ext/jobs/${job.id}/finish`,
      headers: h(),
      payload: { status: 'done', result: {} },
    });
    // a second approved comment is not posted before the gap has passed
    await owner((c) =>
      c.query(
        `insert into outreach.engagement (post_key, comment_draft, status) values ('b', 'z', 'approved')`,
      ),
    );
    expect((await claim()).json().job).toBeNull();
    const ap = (await app.inject({ method: 'GET', url: '/panel/autopost', headers: h() })).json();
    const gapMin = (Date.parse(ap.next) - Date.now()) / 60000;
    expect(gapMin).toBeGreaterThan(29);
    expect(gapMin).toBeLessThan(91);
    expect(ap.posted_today).toBe(1);
  });
});

describe('remote API', () => {
  it('needs the token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { 'x-api-token': 'wrong' } }))
        .statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/status', headers: API })).statusCode).toBe(
      200,
    );
  });

  it('can start rounds and post approved comments, but cannot approve', async () => {
    expect((await enqueue({ kind: 'comment_round' }, API, '/api/jobs')).statusCode).toBe(200);
    expect(
      (await enqueue({ kind: 'post_comment', params: { id: draftId } }, API, '/api/jobs'))
        .statusCode,
    ).toBe(400);
    expect(
      (await enqueue({ kind: 'post_comment', params: { id: approvedId } }, API, '/api/jobs'))
        .statusCode,
    ).toBe(200);
    // there is no approve route on the remote API
    const r = await app.inject({
      method: 'POST',
      url: `/api/comments/${draftId}`,
      headers: API,
      payload: { decision: 'approve' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('robot log and stop', () => {
  const log = (id: number, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/ext/jobs/${id}/log`, headers: h(), payload });

  it('shows the running job with its progress and latest lines', async () => {
    await enqueue({ kind: 'prospect_round' });
    const job = (await claim()).json().job;
    expect((await log(job.id, { message: 'Opened search', step: 'search' })).json()).toEqual({
      ok: true,
      stop: false,
    });
    await log(job.id, { message: 'Profile 1/8', progress: { profiles: 1, maxProfiles: 8 } });
    const robot = (await app.inject({ method: 'GET', url: '/panel/robot', headers: h() })).json();
    expect(robot.running).toMatchObject({ id: job.id, kind: 'prospect_round' });
    expect(robot.running.progress).toEqual({ profiles: 1, maxProfiles: 8 });
    expect(robot.running.events[0].message).toBe('Profile 1/8');
  });

  it('stop cancels a queued job and asks a running job to stop', async () => {
    await enqueue({ kind: 'comment_round' });
    await enqueue({ kind: 'sync_round' });
    const running = (await claim()).json().job;
    const queued = (await app.inject({ method: 'GET', url: '/panel/jobs', headers: h() }))
      .json()
      .find((j: { status: string }) => j.status === 'queued');
    const stop = (id: number) =>
      app.inject({ method: 'POST', url: `/panel/jobs/${id}/stop`, headers: h(), payload: {} });
    expect((await stop(queued.id)).json().state).toBe('cancelled');
    expect((await stop(running.id)).json().state).toBe('stopping');
    expect((await log(running.id, { message: 'next step' })).json().stop).toBe(true);
    await app.inject({
      method: 'POST',
      url: `/ext/jobs/${running.id}/finish`,
      headers: h(),
      payload: { status: 'stopped', result: { message: 'Stopped by Jibran' } },
    });
    // a finished job can no longer log
    expect((await log(running.id, { message: 'late' })).json()).toEqual({ ok: false, stop: true });
    const ev = (
      await app.inject({
        method: 'GET',
        url: `/api/job-events?job=${running.id}`,
        headers: API,
      })
    ).json();
    expect(ev.map((e: { message: string }) => e.message)).toEqual([
      'Stopped by Jibran',
      'next step',
      'Stop requested',
    ]);
  });
});

describe('cut-off jobs', () => {
  it('a new claim from the same device closes the job it was running', async () => {
    await enqueue({ kind: 'capture_sync' });
    await enqueue({ kind: 'comment_round' });
    const first = (await claim()).json().job;
    // the extension restarted mid-job and asks again
    const next = (await claim()).json().job;
    expect(next.kind).toBe('comment_round');
    const jobs = (await app.inject({ method: 'GET', url: '/panel/jobs', headers: h() })).json();
    expect(jobs.find((j: { id: number }) => j.id === first.id).status).toBe('error');
  });
});

describe('pause between jobs', () => {
  it('waits 3-10 minutes between jobs, and only starts jobs in working hours', async () => {
    await setting('job_gap_seconds', '{"min":180,"max":600}');
    await enqueue({ kind: 'capture_sync' });
    await enqueue({ kind: 'comment_round' });
    const first = (await claim()).json().job;
    await app.inject({
      method: 'POST',
      url: `/ext/jobs/${first.id}/finish`,
      headers: h(),
      payload: { status: 'done', result: {} },
    });
    expect((await claim()).json().job).toBeNull();
    const robot = (await app.inject({ method: 'GET', url: '/panel/robot', headers: h() })).json();
    const gap = (Date.parse(robot.next_after) - Date.now()) / 1000;
    expect(gap).toBeGreaterThan(170);
    expect(gap).toBeLessThan(601);

    // Working hours (in this test: each test logs in, and login allows 10 per 15 minutes):
    // outside them, queued jobs wait instead of starting.
    await setting('job_next_after', '""');
    await setting('job_hours', '{"from":0,"to":0}');
    await enqueue({ kind: 'comment_round' });
    expect((await claim()).json()).toEqual({ job: null });
    await setting('job_hours', '{"from":0,"to":24}');
    expect((await claim()).json().job.kind).toBe('comment_round');
  });
});
