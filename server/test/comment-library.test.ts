import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedPost } from '@outreach/shared';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

const fetchMock = vi.fn<FetchLike>(
  async () =>
    new Response(
      JSON.stringify({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [
          {
            message: {
              content: JSON.stringify({
                posts: [
                  {
                    index: 0,
                    verdict: 'skip',
                    reason: 'r',
                    reach_note: '',
                    marketing_level: 0,
                    comment: '',
                  },
                ],
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
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
  await owner(async (c) => {
    await c.query('delete from outreach.comment_samples');
    await c.query('delete from outreach.engagement');
    await c.query('delete from outreach.voice_profiles');
    await c.query(`insert into outreach.voice_profiles (status, approved_at, samples, fingerprint, profile, better)
      values ('draft', null, '{"profile":{"name":"Jibran Shahid","url":"https://www.linkedin.com/in/jibran-shahid/"}}', '{}', '{}', '{}')`);
  });
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});

const auth = () => ({ authorization: `Bearer ${token}` });
const c = (id: string, author: string, text: string, reactions: number | null = null) => ({
  id: `urn:li:comment:(activity:1,${id})`,
  author,
  profile: `https://www.linkedin.com/in/${author.toLowerCase().replace(/ /g, '-')}/`,
  headline: null,
  text,
  reactions,
  reply: false,
  mentions: null,
});
const add = (comments: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/panel/comment-library',
    headers: auth(),
    payload: {
      post: {
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
        author: 'Sandra T',
        excerpt: 'Ein Post',
      },
      comments,
    },
  });

describe('comment library', () => {
  it('stores comments once, recognises Jibran, guesses the language and counts', async () => {
    const first = await add([
      c('1', 'Anna Beispiel', 'Kenne ich genau so, bei uns war es die Checkliste.', 5),
      c('2', 'Jibran Shahid', 'Rena, 2/3 Annahme zeigt, wie viel im Nachfragen liegt.'),
      c('3', 'Tom Doe', 'Great point, the handoff is where it breaks.', 1),
    ]);
    expect(first.json()).toMatchObject({ read: 3, added: 3 });
    // read again: nothing new, likes refreshed
    const again = await add([
      c('1', 'Anna Beispiel', 'Kenne ich genau so, bei uns war es die Checkliste.', 9),
    ]);
    expect(again.json()).toMatchObject({ added: 0 });
    const list = (
      await app.inject({ method: 'GET', url: '/panel/comment-library?filter=all', headers: auth() })
    ).json();
    expect(list.counts).toMatchObject({ all: 3, mine: 1, others: 2, liked: 1, posts: 1 });
    const anna = list.items.find((x: { author: string }) => x.author === 'Anna Beispiel');
    expect(anna).toMatchObject({ reactions: 9, lang: 'de', is_mine: false });
    expect(list.items.find((x: { author: string }) => x.author === 'Tom Doe').lang).toBe('en');
    const mine = (
      await app.inject({
        method: 'GET',
        url: '/panel/comment-library?filter=mine',
        headers: auth(),
      })
    ).json();
    expect(mine.items.map((x: { author: string }) => x.author)).toEqual(['Jibran Shahid']);
  });

  it('saves comments when there is no voice profile to recognise Jibran by', async () => {
    await owner((c) => c.query('delete from outreach.voice_profiles'));
    const res = await add([c('7', 'Anna Beispiel', 'Kenne ich genau so.', 2)]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ read: 1, added: 1 });
    const row = await owner((cl) => cl.query('select is_mine from outreach.comment_samples'));
    expect(row.rows[0].is_mine).toBe(false);
  });

  it('survives a post excerpt cut in the middle of an emoji or special letter', async () => {
    const lone = '𝘒'.slice(0, 1); // a half character, as .slice() leaves at a cut
    const res = await app.inject({
      method: 'POST',
      url: '/panel/comment-library',
      headers: auth(),
      payload: {
        post: {
          url: 'https://www.linkedin.com/feed/update/urn:li:activity:2/',
          author: 'M G',
          excerpt: 'a'.repeat(1499) + lone,
        },
        comments: [c('9', 'Anna Beispiel', `Spannend ${lone} wirklich`)],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ read: 1, added: 1 });
  });

  it('labels good and bad examples and hands them to drafting as style references', async () => {
    await add([
      c('1', 'Anna Beispiel', 'Kenne ich genau so, bei uns war es die Checkliste.', 5),
      c('2', 'Jibran Shahid', 'Rena, 2/3 Annahme zeigt, wie viel im Nachfragen liegt.'),
    ]);
    const items = (
      await app.inject({ method: 'GET', url: '/panel/comment-library', headers: auth() })
    ).json().items as { id: number; author: string }[];
    const mineId = items.find((x) => x.author === 'Jibran Shahid')!.id;
    const bad = await app.inject({
      method: 'POST',
      url: `/panel/comment-library/${mineId}/label`,
      headers: auth(),
      payload: { label: 'bad', note: 'wiederholt nur den Post' },
    });
    expect(bad.json()).toMatchObject({ ok: true, label: 'bad' });
    const wrong = await app.inject({
      method: 'POST',
      url: `/panel/comment-library/${mineId}/label`,
      headers: auth(),
      payload: { label: 'great' },
    });
    expect(wrong.statusCode).toBe(400);

    const post: FeedPost = {
      author: 'Neue Autorin',
      authorHeadline: 'Maklerin',
      authorProfile: 'https://www.linkedin.com/in/neue-autorin/',
      authorFollowers: null,
      text: 'Ein neuer Beitrag über Bestandsbetreuung und Nachfragen.',
      relativeDate: '1h',
      reactions: 10,
      comments: 2,
      media: 'none',
      promoted: false,
      urn: null,
      url: null,
    };
    const scanned = await app.inject({
      method: 'POST',
      url: '/panel/engagement/scan',
      headers: auth(),
      payload: { posts: [post] },
    });
    expect(scanned.statusCode).toBe(200);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).messages[1]
      .content as string;
    expect(sent).toMatch(/<style_examples>/);
    expect(sent).toMatch(
      /never write like this:\n- "Rena, 2\/3 Annahme.*\(wiederholt nur den Post\)/,
    );
    expect(sent).toMatch(/Well-liked comments by other people:\n- "Kenne ich genau so/);
  });
});
