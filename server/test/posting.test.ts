import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let verdict: unknown = { verdict: 'ok', issues: [] };
const fetchMock = vi.fn<FetchLike>(
  async () =>
    new Response(
      JSON.stringify({
        model: 'anthropic/claude-haiku-5.5',
        choices: [{ message: { content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
        usage: { cost: 0.0004 },
      }),
    ),
);
const { app, db } = await makeApp(fetchMock);
let token = '';
let id = 0;
afterAll(async () => {
  await app.close();
  await db.end();
});

const POST =
  'Wir haben 30 % mehr Schadenmeldungen und zwei Kolleginnen, die alles von Hand zuordnen.';
const COMMENT =
  'Bei 30 % mehr Meldungen ist das Zuordnen der eigentliche Engpass, nicht die Meldung selbst.\n\nWie verteilen die beiden Kolleginnen die Fälle heute, nach Sparte oder nach Eingang?';

beforeEach(async () => {
  fetchMock.mockClear();
  verdict = { verdict: 'ok', issues: [] };
  await resetData();
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  id = await owner(async (c) => {
    await c.query('delete from outreach.engagement');
    await c.query(`delete from outreach.settings where key = 'comment_posting_live'`);
    const r = await c.query(
      `insert into outreach.engagement (post_key, author_name, author_headline, post_excerpt, comment_draft, status)
       values ('k1', 'Anna', 'Inhaberin Maklerbüro', $1, $2, 'approved') returning id`,
      [POST, COMMENT],
    );
    return Number(r.rows[0].id);
  });
});

const h = () => ({ authorization: `Bearer ${token}` });
const prepare = () =>
  app.inject({ method: 'POST', url: `/panel/comments/${id}/prepare`, headers: h() });
const result = (r: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/panel/comments/${id}/result`, headers: h(), payload: r });
const attempt = {
  dryRun: true,
  found: true,
  typed: true,
  button: 'Comment',
  clicked: false,
  verified: false,
  postedUrl: null,
  note: 'practice',
};

describe('posting a comment', () => {
  it('passes the fact check and starts in practice mode', async () => {
    const res = await prepare();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ factCheck: 'ok', live: false, text: COMMENT });
  });

  it('blocks an invented number in code, before any AI call', async () => {
    await owner((c) =>
      c.query(
        `update outreach.engagement set comment_draft = replace(comment_draft, '30 %', '45 %')`,
      ),
    );
    const res = await prepare();
    expect(res.statusCode).toBe(422);
    expect(res.json().issues).toContain('number(s) not in the post: 45');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks when the AI fact check finds a misstatement', async () => {
    verdict = {
      verdict: 'block',
      issues: ['says the author has two colleagues per Sparte; the post does not say that'],
    };
    const res = await prepare();
    expect(res.statusCode).toBe(422);
    expect(res.json().issues[0]).toMatch(/does not say/);
    // it leaves "Approved" for "Blocked", with the reason
    const row = await owner((c) => c.query('select status, block_reason from outreach.engagement'));
    expect(row.rows[0]).toMatchObject({
      status: 'blocked',
      block_reason: expect.stringMatching(/does not say/),
    });
    // edited and approved again: back to approved, reason cleared
    const again = await app.inject({
      method: 'POST',
      url: `/panel/comments/${id}`,
      headers: h(),
      payload: { decision: 'approve', text: COMMENT },
    });
    expect(again.statusCode).toBe(200);
    const after = await owner((c) =>
      c.query('select status, block_reason from outreach.engagement'),
    );
    expect(after.rows[0]).toEqual({ status: 'approved', block_reason: null });
  });

  it('only approved comments can be posted', async () => {
    await owner((c) => c.query(`update outreach.engagement set status = 'drafted'`));
    expect((await prepare()).statusCode).toBe(400);
  });

  it('a practice run is logged but never marks the comment posted', async () => {
    expect((await result(attempt)).json()).toMatchObject({ posted: false });
    const row = await owner((c) =>
      c.query('select status, verified, jsonb_array_length(post_log) n from outreach.engagement'),
    );
    expect(row.rows[0]).toEqual({ status: 'approved', verified: false, n: 1 });
  });

  it('only a verified live post marks it posted', async () => {
    expect(
      (await result({ ...attempt, dryRun: false, clicked: true, verified: false })).json().posted,
    ).toBe(false);
    expect(
      (
        await result({
          ...attempt,
          dryRun: false,
          clicked: true,
          verified: true,
          postedUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
        })
      ).json().posted,
    ).toBe(true);
    const row = await owner((c) =>
      c.query('select status, verified, posted_url from outreach.engagement'),
    );
    expect(row.rows[0]).toEqual({
      status: 'posted',
      verified: true,
      posted_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
    });
  });

  it('a pressed but unconfirmed live post is locked as "check" and cannot be posted again', async () => {
    expect(
      (await result({ ...attempt, dryRun: false, clicked: true, verified: false })).json(),
    ).toMatchObject({ posted: false, check: true });
    const row = await owner((c) => c.query('select status from outreach.engagement'));
    expect(row.rows[0].status).toBe('check');
    const again = await app.inject({
      method: 'POST',
      url: '/panel/jobs',
      headers: h(),
      payload: { kind: 'post_comment', params: { id } },
    });
    expect(again.statusCode).toBe(400);
  });

  it('saves the link of the post the robot found', async () => {
    const link = 'https://www.linkedin.com/feed/update/urn:li:activity:7514220442614648832/';
    await result({ ...attempt, postLink: link });
    await result({ ...attempt, postLink: 'https://evil.example/x' });
    expect(
      (await owner((c) => c.query('select post_url from outreach.engagement'))).rows[0].post_url,
    ).toBe(link);
    await owner((c) => c.query(`update outreach.engagement set post_url = null`));
    const ugc = 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7513904589557874691/';
    await result({ ...attempt, postLink: ugc });
    const row = await owner((c) => c.query('select post_url from outreach.engagement'));
    expect(row.rows[0].post_url).toBe(ugc);
  });

  it('switches between practice and live', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/panel/comment-mode', headers: h() })).json(),
    ).toEqual({ live: false });
    await app.inject({
      method: 'POST',
      url: '/panel/comment-mode',
      headers: h(),
      payload: { live: true },
    });
    expect((await prepare()).json().live).toBe(true);
  });
});
