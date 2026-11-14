import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let nextContent: unknown;
const fetchMock = vi.fn<FetchLike>(
  async () =>
    new Response(
      JSON.stringify({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ message: { content: JSON.stringify(nextContent) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3000, completion_tokens: 900, cost: 0.03 },
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
  await resetData();
  await owner((c) => c.query('delete from outreach.voice_profiles'));
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
});
const h = () => ({ authorization: `Bearer ${token}` });

const samples = {
  profile: {
    name: 'Test Person',
    headline: 'KI-Agenten für Maklerbüros',
    about: null,
    experience: [],
  },
  posts: [
    {
      text: 'Bei den Maklerbüros, mit denen wir arbeiten, kostet die Schadenmeldung per Mail zwei Stunden am Tag.',
      date: '2w',
    },
  ],
  comments: [
    {
      text: 'Genau das sehe ich auch: der Engpass ist das Zuordnen, nicht das Lesen.',
      on: 'Post über Posteingang',
      date: '3d',
    },
    { text: 'Spannender Punkt. Wie lösen Sie das mit den Altverträgen?', on: null, date: '1w' },
  ],
};
const profile = (quote: string) => ({
  summary: 'Kurz, konkret, Sie-Form.',
  languages: 'German',
  address_form: 'Sie',
  tone: 'sachlich',
  rhythm: 'mittlere Sätze',
  openers: [],
  closers: [],
  phrases: ['der Engpass ist das Zuordnen', 'ein Satz der nicht vorkommt'],
  avoids: [],
  topics: ['Schadenmeldung'],
  signature_lines: [quote],
  story_bank: [
    {
      fact: 'Schadenmeldung kostet 2 Stunden',
      quote: 'kostet die Schadenmeldung per Mail zwei Stunden am Tag',
    },
  ],
  comment_style: 'zwei Absätze, Frage am Ende',
  coverage_note: 'erste Version, 3 Texte',
  better: {
    keep: ['konkrete Zahlen'],
    drop: [],
    rules: ['eine Zahl statt "viel"'],
    rewrite_example: {
      before: 'Spannender Punkt.',
      after: 'Der Punkt mit den Altverträgen trifft es.',
    },
    headline_options: ['KI-Agenten für Maklerbüros'],
    about_opening: 'Wir bauen KI-Agenten für Maklerbüros.',
  },
});

describe('voice profile', () => {
  it('keeps only quotes that are really in the samples, saves a draft, approval makes it active', async () => {
    nextContent = profile('Genau das sehe ich auch');
    const r = await app.inject({
      method: 'POST',
      url: '/ext/voice/samples',
      headers: h(),
      payload: samples,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().droppedQuotes).toBe(1); // the invented phrase
    const v = (await app.inject({ method: 'GET', url: '/panel/voice', headers: h() })).json();
    expect(v.draft.profile.phrases).toEqual(['der Engpass ist das Zuordnen']);
    expect(v.draft.fingerprint.address.sie).toBe(1);
    expect(v.approved).toBeNull();
    await app.inject({
      method: 'POST',
      url: `/panel/voice/${v.draft.id}`,
      headers: h(),
      payload: { decision: 'approve' },
    });
    const after = (await app.inject({ method: 'GET', url: '/panel/voice', headers: h() })).json();
    expect(after.approved.id).toBe(v.draft.id);
    expect(after.draft).toBeNull();
    // drafting sees the approved voice, including the sharper rules
    const forDrafting = await owner((c) =>
      c.query(
        `select public.ext_voice_for_drafting((select id from outreach.app_users limit 1)) v`,
      ),
    );
    expect(forDrafting.rows[0].v.profile.better.rules).toEqual(['eine Zahl statt "viel"']);
  });

  it('keeps the samples when the AI fails, and "try again" uses them', async () => {
    nextContent = { not: 'a profile' }; // schema mismatch on every attempt
    const r = await app.inject({
      method: 'POST',
      url: '/ext/voice/samples',
      headers: h(),
      payload: samples,
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const v = (await app.inject({ method: 'GET', url: '/panel/voice', headers: h() })).json();
    expect(v.failed).toMatchObject({ posts: 1, comments: 2 });
    nextContent = profile('Genau das sehe ich auch');
    const again = await app.inject({
      method: 'POST',
      url: '/panel/voice/retry',
      headers: h(),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/panel/voice', headers: h() })).json();
    expect(after.failed).toBeNull();
    expect(after.draft.profile.summary).toBe('Kurz, konkret, Sie-Form.');
  });

  it('profile check: findings plus rewrites, invented numbers are retried away', async () => {
    nextContent = profile('Genau das sehe ich auch');
    await app.inject({ method: 'POST', url: '/ext/voice/samples', headers: h(), payload: samples });
    const rewrites = (about: string) => ({
      score: 40,
      priorities: ['Headline mit Suchbegriffen'],
      headline_options: ['KI-Agenten für Maklerbüros | Schadenmeldung in Minuten'],
      about,
      current_role: { title: 'Gründer', description: 'KI-Agenten für Makler.' },
      skills_top: ['KI-Agenten'],
      featured_post_indexes: [0, 7],
      notes: '',
    });
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call++;
      const content =
        call === 1
          ? rewrites('Wir sparen 40 % Zeit.')
          : rewrites('Die Schadenmeldung kostet zwei Stunden am Tag.');
      return new Response(
        JSON.stringify({
          model: 'anthropic/claude-sonnet-5.5',
          choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3000, completion_tokens: 900, cost: 0.02 },
        }),
      );
    });
    const r = await app.inject({
      method: 'POST',
      url: '/panel/profile-check',
      headers: h(),
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(call).toBe(2); // the first answer invented "40" and was retried
    const c = (
      await app.inject({ method: 'GET', url: '/panel/profile-check', headers: h() })
    ).json();
    expect(c.rewrites.about).toMatch(/zwei Stunden/);
    expect(c.rewrites.featured_post_indexes).toEqual([0]); // index 7 does not exist
    expect(c.findings.find((f: { section: string }) => f.section === 'headline').status).not.toBe(
      'pass',
    );
  });

  it('needs at least 3 texts', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/ext/voice/samples',
      headers: h(),
      payload: { ...samples, comments: [] },
    });
    expect(r.statusCode).toBe(400);
  });
});
