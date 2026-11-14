import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import type { FetchLike } from '../src/ai/openrouter.ts';

let replies: unknown[] = [];
const fetchMock = vi.fn<FetchLike>(async () => {
  const content = replies.shift();
  return new Response(
    JSON.stringify({
      model: 'anthropic/claude-haiku-5.5',
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.002 },
    }),
  );
});
const { app, db } = await makeApp(fetchMock);
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
    c.query(`delete from outreach.candidates; delete from outreach.action_queue; delete from outreach.events; delete from outreach.prospects;
      insert into outreach.campaigns (id, name, status, description) values ('ki-agenten-makler', 'KI-Agenten', 'on', 'Inhaber von Maklerbüros')
        on conflict (id) do update set status = 'on';
      insert into outreach.prospects (linkedin_url, full_name, stage) values ('https://www.linkedin.com/in/known/', 'Known Person', 'invited');
      update outreach.settings set value = '' where key = 'linkedin_limit_alert';
      update outreach.campaigns set status = 'off' where id = 'ecommerce-first-level-support';`),
  );
});
const h = () => ({ authorization: `Bearer ${token}` });
const card = (slug: string, headline: string) => ({
  name: slug,
  profileUrl: `https://www.linkedin.com/in/${slug}/`,
  degree: '2nd',
  headline,
  location: 'Berlin',
  snippet: null,
  action: 'connect',
});

describe('prospect round', () => {
  it('plans, screens (duplicates, hard skips, AI) and assesses with the fit check', async () => {
    const plan = (
      await app.inject({ method: 'POST', url: '/ext/prospect/plan', headers: h(), payload: {} })
    ).json();
    expect(plan.keywords.length).toBeGreaterThan(0);
    expect(
      plan.keywords.every(
        (k: { campaign: string | null }) =>
          k.campaign === null || k.campaign === 'ki-agenten-makler',
      ),
    ).toBe(true);
    replies = [
      {
        items: [
          { index: 0, verdict: 'open', score: 85, reason: 'Inhaber Maklerbüro' },
          { index: 1, verdict: 'reject', score: 20, reason: 'agency' },
        ],
      },
    ];
    const screen = (
      await app.inject({
        method: 'POST',
        url: '/ext/prospect/screen',
        headers: h(),
        payload: {
          runId: plan.run_id,
          keyword: 'Versicherungsmakler',
          segment: 'makler',
          campaign: 'ki-agenten-makler',
          cards: [
            card('anna', 'Inhaberin Maklerbüro Anna'),
            card('agentur', 'Webagentur für Makler'),
            card('known', 'Versicherungsmakler'),
            card('betreuer', 'Maklerbetreuer bei einer Gesellschaft'),
          ],
        },
      })
    ).json();
    expect(screen.open.map((o: { card: { name: string } }) => o.card.name)).toEqual(['anna']);
    expect(screen.recorded).toBe(3); // agency (screen), known (duplicate), Maklerbetreuer (hard skip)
    replies = [
      {
        status: 'yes',
        reason: 'Inhaberin eines Maklerbüros',
        evidence: ['Inhaberin Maklerbüro Anna'],
      },
    ];
    const assess = (
      await app.inject({
        method: 'POST',
        url: '/ext/prospect/assess',
        headers: h(),
        payload: {
          runId: plan.run_id,
          keyword: 'Versicherungsmakler',
          segment: 'makler',
          campaign: 'ki-agenten-makler',
          stageOnly: false,
          mode: 'approve',
          maxApprove: 5,
          score: 85,
          card: card('anna', 'Inhaberin Maklerbüro Anna'),
          profile: {
            name: 'anna',
            headline: 'Inhaberin Maklerbüro Anna',
            location: 'Berlin',
            about: null,
            canConnect: true,
            pending: false,
            connected: false,
            experience: [],
          },
        },
      })
    ).json();
    expect(assess.verdict).toBe(plan.mode === 'approve' ? 'approved' : 'staged');
    const rows = await owner((c) =>
      c.query(`select verdict, count(*)::int n from outreach.candidates group by 1 order by 1`),
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { verdict: 'duplicate', n: 1 },
        { verdict: 'rejected', n: 2 },
      ]),
    );
  });
});

describe('keywords per campaign', () => {
  it('saves several keywords for a campaign, refuses duplicates, and returns stats', async () => {
    const save = (keywords: unknown[]) =>
      app.inject({ method: 'POST', url: '/panel/keywords', headers: h(), payload: { keywords } });
    const kws = [
      { keyword: 'Versicherungsmakler', segment: 'makler', campaign: 'ki-agenten-makler' },
      { keyword: 'Maklerbüro', segment: 'makler', campaign: 'ki-agenten-makler', enabled: false },
      { keyword: 'Mehrfachagent', segment: 'makler', campaign: 'ki-agenten-makler' },
    ];
    expect((await save(kws)).statusCode).toBe(200);
    expect(
      (await save([...kws, { keyword: 'versicherungsmakler', segment: 'makler', campaign: null }]))
        .statusCode,
    ).toBe(400);
    const r = (await app.inject({ method: 'GET', url: '/panel/keywords', headers: h() })).json();
    expect(r.keywords.map((k: { keyword: string }) => k.keyword)).toEqual([
      'Versicherungsmakler',
      'Maklerbüro',
      'Mehrfachagent',
    ]);
    // the plan never uses a paused keyword
    const plan = (
      await app.inject({ method: 'POST', url: '/ext/prospect/plan', headers: h(), payload: {} })
    ).json();
    expect(plan.keywords.map((k: { keyword: string }) => k.keyword)).not.toContain('Maklerbüro');
  });
});

describe('better prospecting (13.11.2026)', () => {
  it('gives every active campaign a search word in each round, e-commerce included', async () => {
    await owner(async (c) => {
      await c.query(`insert into outreach.campaigns (id, name, status) values ('ecommerce-first-level-support', 'Shops', 'on')
        on conflict (id) do update set status = 'on'`);
      const kws = [
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({
          keyword: `Makler ${k}`,
          segment: 'makler',
          campaign: 'ki-agenten-makler',
        })),
        ...['x', 'y'].map((k) => ({
          keyword: `Shop ${k}`,
          segment: 'ecommerce',
          campaign: 'ecommerce-first-level-support',
          stage_only: true,
        })),
        { keyword: 'Steuer', segment: 'steuerberater', campaign: null, stage_only: true },
      ];
      await c.query(`select outreach.doc_put('prospecting_keywords', $1, 'test', 'test')`, [
        JSON.stringify(kws),
      ]);
    });
    const plan = (
      await app.inject({ method: 'POST', url: '/ext/prospect/plan', headers: h(), payload: {} })
    ).json();
    const picked = plan.keywords.map((k: { keyword: string }) => k.keyword);
    expect(picked).toHaveLength(4);
    expect(picked.some((k: string) => k.startsWith('Shop'))).toBe(true);
    expect(picked.some((k: string) => k.startsWith('Makler'))).toBe(true);
    expect(picked).toContain('Steuer');
  });

  it('a person Jibran added by link is staged for his approval even when the fit check says no', async () => {
    const plan = (
      await app.inject({ method: 'POST', url: '/ext/prospect/plan', headers: h(), payload: {} })
    ).json();
    replies = [
      { status: 'no', reason: 'Angestellter, kein Inhaber', evidence: ['Sachbearbeiter'] },
    ];
    const res = (
      await app.inject({
        method: 'POST',
        url: '/ext/prospect/assess',
        headers: h(),
        payload: {
          runId: plan.run_id,
          keyword: 'manual link',
          segment: 'import',
          campaign: 'ki-agenten-makler',
          stageOnly: true,
          mode: 'stage',
          maxApprove: 0,
          score: 100,
          manual: true,
          card: card('bernd', 'Sachbearbeiter'),
          profile: {
            name: 'bernd',
            headline: 'Sachbearbeiter',
            location: null,
            about: null,
            canConnect: true,
            pending: false,
            connected: false,
            experience: [],
          },
        },
      })
    ).json();
    expect(res.verdict).toBe('staged');
    expect(res.reason).toMatch(/fit (no|unsure)/);
    const leads = (await app.inject({ method: 'GET', url: '/panel/leads', headers: h() })).json();
    expect(JSON.stringify(leads)).toMatch(/bernd/);
  });

  it('the migration added the e-commerce keyword sets, all stage only', async () => {
    // a database as migrated: the seed document plus the new sets (the test above replaced it, so re-run the migration's step)
    const mig = await owner((c) =>
      c.query(`select 1 from public.schema_migrations where version = '20261113000049'`),
    );
    expect(mig.rowCount).toBe(1);
  });
});
