import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let nextContent: unknown;
// Per task (json_schema name), when a test needs the two study calls to answer differently.
let byTask: Record<string, unknown> = {};
const fetchMock = vi.fn<FetchLike>(
  async (_url, init) =>
    new Response(
      JSON.stringify({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [
          {
            message: {
              content: (() => {
                const name = JSON.parse(String(init!.body)).response_format.json_schema.name;
                const c = name in byTask ? byTask[name] : nextContent;
                return typeof c === 'string' ? c : JSON.stringify(c);
              })(),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5000, completion_tokens: 1500, cost: 0.05 },
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
beforeEach(async () => {
  fetchMock.mockClear();
  byTask = {};
  await resetData();
  await owner(async (c) => {
    await c.query('delete from outreach.comment_studies');
    await c.query('delete from outreach.comment_samples');
    for (let p = 0; p < 6; p++)
      for (let k = 0; k < 3; k++)
        await c.query(
          `insert into outreach.comment_samples (comment_urn, post_url, post_author, post_excerpt, author, text, reactions, is_mine)
           values ($1, $2, 'Rena G', 'Ein Post über Bestandsbetreuung', $3, $4, $5, $6)`,
          [
            `urn:${p}:${k}`,
            `https://www.linkedin.com/feed/update/urn:li:activity:${p}/`,
            k === 2 ? 'Jibran Shahid' : `Person ${k}`,
            k === 2
              ? 'Rena, 2/3 Annahme zeigt, wie viel im Nachfragen liegt.'
              : 'Kenne ich, bei uns genauso 😅',
            k,
            k === 2,
          ],
        );
  });
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});

const study = {
  posts: [0, 1, 2, 3, 4, 5].map((index) => ({
    index,
    topic: 'BU im Bestand',
    kind: 'story',
    asks_readers: false,
    best_comment: 0,
    why: 'kurz, eigene Erfahrung',
  })),
  findings: {
    summary: 'Menschen schreiben kurz und aus eigener Erfahrung.',
    by_kind: [
      { kind: 'story', how_people_comment: 'eigene Erfahrung, ein Satz' },
      // 14.11.2026: long labels like this were refused, so the whole study failed
      {
        kind: 'Announcement / event invitation with a personal note',
        how_people_comment: 'kurze Glückwünsche',
      },
    ],
    relevance: 'Relevant ist, was etwas Eigenes beiträgt.',
    jibran_differs: ['beginnt mit dem Namen und fasst den Post zusammen'],
    copy: ['eigene Erfahrung in einem Satz'],
    avoid: ['Name + Zusammenfassung'],
  },
  drafting:
    'DRAFTING:\n- Open with your own thought, never with the author’s name.\n- 40-180 characters, one paragraph by default. See https://example.com and Brandovise.',
};

describe('comment study', () => {
  it('analyses the library, proposes rules, and applies them only on decide', async () => {
    const before = await owner((c) =>
      c.query(
        `select outreach.doc('engagement_rules')::text r, (select max(version) from outreach.docs where doc_key = 'engagement_rules') v`,
      ),
    );
    nextContent = study;
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library/analyze',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ posts: 6, comments: 18 });
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1]
      .content as string;
    expect(sent).toMatch(/\[JIBRAN\] Jibran Shahid/);
    expect(sent).toMatch(/<page_data>/);

    const latest = (
      await app.inject({ method: 'GET', url: '/panel/comment-library/study', headers: auth() })
    ).json();
    expect(latest.status).toBe('ready');
    expect(latest.stats.mine.share.opensWithName).toBe(1);
    expect(latest.stats.others.share.opensWithName).toBe(0);
    expect(latest.proposed_rules).toMatch(/never with the author’s name/);
    expect(latest.proposed_rules).not.toMatch(/example\.com|and Brandovise/);
    expect(latest.proposed_rules).toMatch(/Hard limits \(always, set in code\)/);
    expect(latest.proposed_rules).toMatch(/^ADMISSION/m); // other sections kept
    expect(latest.proposed_rules).toMatch(/^MARKETING LEVEL:/m);
    // nothing changed yet
    const mid = await owner((c) =>
      c.query(`select max(version) v from outreach.docs where doc_key = 'engagement_rules'`),
    );
    expect(mid.rows[0].v).toBe(before.rows[0].v);

    const applied = await app.inject({
      method: 'POST',
      url: `/panel/comment-library/study/${latest.id}/decide`,
      headers: auth(),
      payload: { decision: 'apply' },
    });
    expect(applied.json()).toMatchObject({ ok: true, status: 'applied' });
    const after = await owner((c) => c.query(`select outreach.doc('engagement_rules')::text r`));
    expect(after.rows[0].r).toBe(latest.proposed_rules);
    const twice = await app.inject({
      method: 'POST',
      url: `/panel/comment-library/study/${latest.id}/decide`,
      headers: auth(),
      payload: { decision: 'apply' },
    });
    expect(twice.statusCode).toBe(400);
  });

  it('saves the study when only the post labels fail (14.11.2026)', async () => {
    const { posts: _posts, ...rest } = study;
    void _posts;
    byTask = { comment_study: rest, comment_study_posts: { posts: 'nope' } };
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library/analyze',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const latest = (
      await app.inject({ method: 'GET', url: '/panel/comment-library/study', headers: auth() })
    ).json();
    expect(latest.status).toBe('ready');
    expect(latest.findings.posts).toEqual([]);
  });

  it('logs why an almost empty answer was refused (14.11.2026)', async () => {
    // What production got three times: the shape filled with empty strings and padded with blanks.
    const skeleton =
      JSON.stringify({
        findings: {
          summary: '',
          by_kind: [],
          relevance: '',
          jibran_differs: [],
          copy: [],
          avoid: [],
        },
        drafting: '',
      }) + ' '.repeat(5000);
    byTask = { comment_study: skeleton, comment_study_posts: { posts: [] } };
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library/analyze',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const log = await owner((c) =>
      c.query(
        `select error from outreach.ai_calls where task = 'comment_study' and not ok order by created_at desc limit 1`,
      ),
    );
    expect(log.rows[0].error).toMatch(/findings\.summary/);
    expect(log.rows[0].error).toMatch(/whitespace\), finish stop/);
  });

  it('refuses to analyse a library with fewer than 5 discussed posts', async () => {
    await owner((c) =>
      c.query(`delete from outreach.comment_samples where post_url not like '%activity:0/'`),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library/analyze',
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/collect at least 5/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plans posts the robot saw that are not in the library yet', async () => {
    await owner((c) =>
      c.query(`delete from outreach.engagement where post_key in ('k1', 'k2');
        insert into outreach.engagement (post_key, post_url, author_name, status) values
        ('k1', 'https://www.linkedin.com/feed/update/urn:li:activity:99/', 'X', 'skipped'),
        ('k2', 'https://www.linkedin.com/feed/update/urn:li:activity:0/', 'Y', 'posted')`),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library/study-plan',
      headers: auth(),
      payload: { limit: 5 },
    });
    expect(res.json().posts).toEqual(['https://www.linkedin.com/feed/update/urn:li:activity:99/']);
  });
});
