import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedPost } from '@outreach/shared';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let nextContent: unknown;
const fetchMock = vi.fn<FetchLike>(
  async () =>
    new Response(
      JSON.stringify({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ message: { content: JSON.stringify(nextContent) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 900, cost: 0.02 },
      }),
    ),
);
const { app, db } = await makeApp(fetchMock);
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  fetchMock.mockClear();
  await resetData();
  await owner((c) => c.query('delete from outreach.engagement'));
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});

const post = (i: number, extra: Partial<FeedPost> = {}): FeedPost => ({
  author: `Autor ${i}`,
  authorHeadline: 'Inhaberin Maklerbüro',
  authorProfile: `https://www.linkedin.com/in/autor-${i}/`,
  authorFollowers: '2,100 followers',
  text: `Beitrag ${i}: Schadenmeldungen per E-Mail fressen unseren Innendienst auf.`,
  relativeDate: '2h',
  reactions: 40,
  comments: 3,
  media: 'none',
  promoted: false,
  urn: null,
  url: null,
  ...extra,
});
const GOOD =
  'Genau da setzt es an: Die Meldung ist selten das Problem, sondern das Zuordnen zum richtigen Vertrag im MVP.\n\nWie viele der Mails landen bei Ihnen heute schon ohne Handarbeit in der richtigen Akte, und wo hakt es am häufigsten?';
const scan = (posts: FeedPost[]) =>
  app.inject({
    method: 'POST',
    url: '/panel/engagement/scan',
    headers: { authorization: `Bearer ${token}` },
    payload: { posts },
  });

describe('engagement scan', () => {
  it('drafts, turns a rule-breaking draft into a skip, and stores everything', async () => {
    nextContent = {
      posts: [
        {
          index: 0,
          verdict: 'draft',
          reason: 'ICP owner, open thread',
          reach_note: '2.1k followers',
          marketing_level: 0,
          comment: GOOD,
        },
        {
          index: 1,
          verdict: 'draft',
          reason: 'x',
          reach_note: 'y',
          marketing_level: 1,
          comment: 'Toller Post #KI von Brandovise',
        },
        {
          index: 2,
          verdict: 'skip',
          reason: 'video teaser',
          reach_note: '',
          marketing_level: 0,
          comment: '',
        },
      ],
    };
    const res = await scan([post(0), post(1), post(2, { media: 'video' })]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      seen: 3,
      alreadyKnown: 0,
      drafted: 1,
      skipped: 2,
      rejectedDrafts: 1,
    });
    const rows = await owner((c) =>
      c.query(
        'select author_name, status, comment_draft, reason from outreach.engagement order by author_name',
      ),
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['drafted', 'skipped', 'skipped']);
    expect(rows.rows[0].comment_draft).toBe(GOOD);
    expect(rows.rows[1].reason).toMatch(/draft failed checks/);
    // the page text went to the model fenced as data
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1].content).toMatch(
      /<page_data>[\s\S]*Autor 0/,
    );
  });

  it('does not call the AI again for posts it already handled', async () => {
    nextContent = {
      posts: [
        { index: 0, verdict: 'skip', reason: 'r', reach_note: '', marketing_level: 0, comment: '' },
      ],
    };
    await scan([post(5)]);
    fetchMock.mockClear();
    const res = await scan([post(5)]);
    expect(res.json()).toMatchObject({ seen: 1, alreadyKnown: 1, drafted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips sponsored posts in code without an AI call', async () => {
    const res = await scan([post(7, { promoted: true })]);
    expect(res.json()).toMatchObject({ seen: 1, drafted: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await owner((c) => c.query(`select status, reason from outreach.engagement`));
    expect(row.rows[0]).toEqual({ status: 'skipped', reason: 'sponsored post (always skipped)' });
  });

  it('skips authors commented on in the last 7 days (or with an open draft) without an AI call', async () => {
    await owner((c) =>
      c.query(`insert into outreach.engagement (post_key, author_name, author_profile, status, posted_at) values
        ('old-8', 'Autor 8', 'https://www.linkedin.com/in/autor-8/', 'posted', now() - interval '2 days'),
        ('old-9', 'Autor 9', 'https://www.linkedin.com/in/autor-9/', 'posted', now() - interval '10 days'),
        ('old-10', 'Autor 10', 'https://www.linkedin.com/in/autor-10/', 'approved', null)`),
    );
    nextContent = {
      posts: [
        { index: 0, verdict: 'skip', reason: 'r', reach_note: '', marketing_level: 0, comment: '' },
      ],
    };
    const res = await scan([post(8), post(9), post(10)]);
    expect(res.json()).toMatchObject({ seen: 3, drafted: 0, skipped: 3 });
    // only Autor 9 (last comment 10 days ago) went to the AI
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1].content;
    expect(sent).toMatch(/Autor 9/);
    expect(sent).not.toMatch(/Autor 8|Autor 10/);
    const rows = await owner((c) =>
      c.query(
        `select author_name, reason from outreach.engagement where post_key not like 'old-%' order by author_name`,
      ),
    );
    expect(rows.rows[0].reason).toMatch(/already open \(approved\)/); // Autor 10
    expect(rows.rows[1].reason).toMatch(/commented on Autor 8 on .*pause of 7 days/);
  });

  it('turns a draft in the wrong language into a skip', async () => {
    nextContent = {
      posts: [
        {
          index: 0,
          verdict: 'draft',
          reason: 'ICP',
          reach_note: '',
          marketing_level: 0,
          comment: GOOD,
        },
      ],
    };
    const res = await scan([
      post(11, {
        text: 'Do you own your AI memory? When you move from one AI tool to another, the context stays behind and you start again.',
      }),
    ]);
    expect(res.json()).toMatchObject({ drafted: 0, skipped: 1, rejectedDrafts: 1 });
    const row = await owner((c) => c.query(`select reason from outreach.engagement`));
    expect(row.rows[0].reason).toMatch(/written in de but the post is in en/);
  });

  it('lets the own example through once and skips a draft that repeats it or an open comment', async () => {
    await owner((c) =>
      c.query(`insert into outreach.engagement (post_url, author_name, comment_draft, status)
               values ('https://www.linkedin.com/feed/update/urn:li:activity:1/', 'Frühere Autorin',
                       'Meist fehlt die Regel, wann der Chatbot an einen Menschen übergibt.', 'drafted')`),
    );
    const kfz = (who: string) =>
      `${who}, genau an der Stelle hakt es oft.\n\nBeim automatisierten Kfz-Vergleich, den ich gebaut habe, lag die meiste Arbeit im Bestand.`;
    const draft = (index: number, comment: string) => ({
      index,
      verdict: 'draft',
      reason: 'ICP',
      reach_note: '',
      marketing_level: 1,
      comment,
    });
    nextContent = {
      posts: [
        draft(0, kfz('Anna')),
        draft(1, kfz('Bernd').replace('genau an der Stelle hakt es oft', 'das kenne ich')),
        draft(
          2,
          'Oft fehlt die Regel, wann der Chatbot an einen Menschen übergibt, gerade im Innendienst.',
        ),
      ],
    };
    const res = await scan([post(20), post(21), post(22)]);
    expect(res.json()).toMatchObject({ drafted: 1, rejectedDrafts: 2 });
    const rows = await owner((c) =>
      c.query(`select author_name, status, reason from outreach.engagement
               where author_name like 'Autor 2_' order by author_name`),
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['drafted', 'skipped', 'skipped']);
    expect(rows.rows[1].reason).toMatch(/own example \(Kfz-Vergleich\) is already/);
    expect(rows.rows[2].reason).toMatch(/repeats "fehlt die regel wann der"/);
  });

  it('stores a post whose text is cut inside a special letter at the 3000 limit', async () => {
    nextContent = {
      posts: [
        { index: 0, verdict: 'skip', reason: 'r', reach_note: '', marketing_level: 0, comment: '' },
      ],
    };
    const res = await scan([post(13, { text: 'a'.repeat(2999) + '𝘒𝘦𝘺𝘯𝘰𝘵𝘦' })]);
    expect(res.statusCode).toBe(200);
    const row = await owner((c) =>
      c.query(`select length(post_excerpt) n from outreach.engagement`),
    );
    expect(row.rows[0].n).toBe(3000);
  });

  it('splits a large scan into batches of 10 and retries an empty answer once', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (_u, init) => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }),
        );
      }
      const n = (String(init!.body).match(/\[\d+\] Autor/g) ?? []).length;
      const posts = Array.from({ length: n }, (_, index) => ({
        index,
        verdict: 'skip',
        reason: 'test',
        reach_note: '',
        marketing_level: 0,
        comment: '',
      }));
      return new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { content: JSON.stringify({ posts }) }, finish_reason: 'stop' }],
          usage: { cost: 0.01 },
        }),
      );
    });
    const res = await scan(Array.from({ length: 19 }, (_, i) => post(100 + i)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ seen: 19, skipped: 19 });
    expect(calls).toBe(3); // empty answer + retry for batch 1, then batch 2
  });

  it('lists campaigns with their status', async () => {
    await owner((c) =>
      c.query(
        `insert into outreach.campaigns (id, name, status) values ('eng-c', 'Eng', 'off') on conflict do nothing`,
      ),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/panel/campaigns',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'eng-c', status: 'off' })]),
    );
  });
});
