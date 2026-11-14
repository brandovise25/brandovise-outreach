import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import { resolveLeadCompanies } from '../src/web/discover.ts';
import type { AppDeps } from '../src/app.ts';

// Finding companies: web search (key from Settings, daily cap), OpenStreetMap, the website of a lead,
// and the plan for the robot's owner lookup. The outside services are faked.

let organic: { link: string; title: string }[] = [];
let osm: { type: string; id: number; tags: Record<string, string> }[] = [];
const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
const webFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
  calls.push({
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: String(init?.body ?? ''),
  });
  return new Response(
    JSON.stringify(String(url).includes('serper') ? { organic } : { elements: osm }),
  );
}) as unknown as typeof fetch;
const { app, db } = await makeApp(undefined, webFetch);
let token = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
const auth = () => ({ authorization: `Bearer ${token}` });
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(), payload: payload as object });
const KEY = 'serper-test-key-000011112222';

beforeEach(async () => {
  calls.length = 0;
  organic = [
    { link: 'https://www.laufshop-mueller.de/schuhe', title: 'Laufshop Müller' },
    { link: 'https://www.amazon.de/laufschuhe', title: 'Amazon' },
    { link: 'https://radladen.example/shop', title: 'Radladen' },
    { link: 'https://www.laufshop-mueller.de/', title: 'again' },
  ];
  osm = [
    {
      type: 'node',
      id: 11,
      tags: { name: 'Makler Eins', website: 'https://makler-eins.example', 'addr:city': 'Köln' },
    },
    { type: 'way', id: 12, tags: { name: 'Ohne Website' } },
    {
      type: 'node',
      id: 13,
      tags: { name: 'Makler Zwei', 'contact:website': 'makler-zwei.example/kontakt' },
    },
  ];
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
      `delete from outreach.action_queue; delete from outreach.candidates; delete from outreach.prospects`,
    );
    await c.query(
      `delete from outreach.observations; delete from outreach.companies; delete from outreach.search_log; delete from outreach.secrets`,
    );
    await c.query(`update outreach.settings set value = '4' where key = 'search_daily_cap'`);
    await c.query(`delete from outreach.campaigns where id = 'test-camp'`);
    await c.query(
      `insert into outreach.campaigns (id, name, status) values ('test-camp', 'Test', 'on')`,
    );
  });
});

describe('web search', () => {
  it('needs the key from Settings', async () => {
    const r = await post('/panel/companies/search', { query: 'laufschuhe online shop' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Settings/);
    expect(calls.length).toBe(0);
  });

  it('adds the websites of the results, counts the search and stops at the daily cap', async () => {
    await post('/panel/secrets/serper_api_key', { value: KEY });
    const r = await post('/panel/companies/search', {
      query: 'laufschuhe online shop',
      campaign: 'test-camp',
    });
    expect(r.json()).toMatchObject({
      found: 2,
      added: 2,
      known: 0,
      searches: 1,
      used_today: 1,
      cap: 4,
    });
    expect(calls[0]!.url).toBe('https://google.serper.dev/search');
    expect(calls[0]!.headers['x-api-key']).toBe(KEY);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      q: 'laufschuhe online shop',
      gl: 'de',
      page: 1,
    });
    const list = (
      await app.inject({ method: 'GET', url: '/panel/companies', headers: auth() })
    ).json();
    expect(list.items.map((x: { domain: string }) => x.domain).sort()).toEqual([
      'laufshop-mueller.de',
      'radladen.example',
    ]);
    expect(list.items[0]).toMatchObject({ source: 'search', campaign_id: 'test-camp' });
    // the key never comes back
    const usage = (
      await app.inject({ method: 'GET', url: '/panel/companies/search-usage', headers: auth() })
    ).json();
    expect(usage).toMatchObject({ has_key: true, used_today: 1, cap: 4 });
    expect(JSON.stringify(usage)).not.toContain(KEY);
    // three more searches are allowed, the fifth is refused before any call
    for (let i = 0; i < 3; i++) await post('/panel/companies/search', { query: `suche ${i} shop` });
    calls.length = 0;
    const over = await post('/panel/companies/search', { query: 'noch eine suche' });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/used up/);
    expect(calls.length).toBe(0);
  });
});

describe('offices from OpenStreetMap', () => {
  it('adds offices with a website once, and refuses odd city names', async () => {
    const r = await post('/panel/companies/offices', {
      city: 'Köln',
      kind: 'insurance',
      campaign: 'test-camp',
    });
    expect(r.json()).toMatchObject({ places: 3, found: 2, added: 2, already: false });
    expect(calls[0]!.url).toBe('https://overpass-api.de/api/interpreter');
    expect(decodeURIComponent(calls[0]!.body)).toContain('area["name"="Köln"]');
    expect(decodeURIComponent(calls[0]!.body)).toContain('["office"="insurance"]');
    const list = (
      await app.inject({ method: 'GET', url: '/panel/companies', headers: auth() })
    ).json();
    expect(
      list.items.find((x: { domain: string }) => x.domain === 'makler-eins.example'),
    ).toMatchObject({
      name: 'Makler Eins',
      source: 'osm',
      city: 'Köln',
      segment: 'insurance',
    });
    calls.length = 0;
    const again = await post('/panel/companies/offices', { city: 'Köln', kind: 'insurance' });
    expect(again.json()).toMatchObject({ already: true });
    const bad = await post('/panel/companies/offices', {
      city: 'Köln"];node(1);out;//',
      kind: 'insurance',
    });
    expect(bad.statusCode).toBe(400);
    expect(calls.length).toBe(0);
  });
});

describe('owner lookup plan', () => {
  it('lists companies with an owner and a campaign, and records the outcome', async () => {
    await owner(async (c) => {
      await c.query(`insert into outreach.companies (id, domain, name, source, campaign_id, profile_status, profiled_at) values
        (601, 'mit-inhaber.example', 'Mit Inhaber GmbH', 'manual', 'test-camp', 'ok', now()),
        (602, 'ohne-kampagne.example', null, 'manual', null, 'ok', now()),
        (603, 'ohne-inhaber.example', null, 'manual', 'test-camp', 'ok', now()),
        (604, 'nicht-gelesen.example', null, 'manual', 'test-camp', null, null)`);
      await c.query(`insert into outreach.observations (company_id, signal_code, value_text, confidence) values
        (601, 'OWNER_NAME', 'Erika Beispiel', 0.9), (602, 'OWNER_NAME', 'Otto Ohne', 0.9)`);
    });
    const plan = (await post('/panel/companies/lookup-plan', {})).json();
    expect(plan.items).toEqual([
      expect.objectContaining({ id: 601, owner: 'Erika Beispiel', campaign_id: 'test-camp' }),
    ]);
    expect(plan).toMatchObject({ waiting: 2, without_campaign: 1 });
    await post('/panel/companies/campaign', { campaign: 'test-camp' });
    expect((await post('/panel/companies/lookup-plan', {})).json().items.length).toBe(2);
    await post('/panel/companies/601/lookup', { status: 'found' });
    const after = (await post('/panel/companies/lookup-plan', {})).json();
    expect(after.items.map((x: { id: number }) => x.id)).toEqual([602]);
    const rows = await owner((c) =>
      c.query(`select id, lookup_status from outreach.companies order by id`),
    );
    expect(rows.rows.map((r) => r.lookup_status)).toEqual(['found', null, 'no_owner', null]);
    // the robot may be asked to run it
    const job = await post('/ext/jobs', { kind: 'company_lookup', params: { max: 3 } });
    expect(job.statusCode).toBeLessThan(300);
  });
});

describe('website of a lead found on LinkedIn', () => {
  it('links the company only when the website carries its name, and tries each lead once', async () => {
    await post('/panel/secrets/serper_api_key', { value: KEY });
    await owner(async (c) => {
      await c.query(`insert into outreach.candidates (id, full_name, company, linkedin_url, verdict, campaign_id, found_at) values
        (801, 'Tom Müller', 'Laufshop Müller GmbH', 'https://www.linkedin.com/in/tom-m/', 'staged', 'test-camp', now()),
        (802, 'Eva Fremd', 'Ganz Anders AG', 'https://www.linkedin.com/in/eva-f/', 'staged', 'test-camp', now())`);
    });
    const deps = {
      db,
      config: { JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test' },
    } as unknown as AppDeps;
    const userId = (await owner((c) => c.query(`select id from outreach.app_users limit 1`)))
      .rows[0].id;
    calls.length = 0;
    expect(await resolveLeadCompanies(deps, userId, 5, webFetch)).toBe(1);
    expect(calls.length).toBe(2);
    const rows = await owner((c) =>
      c.query(`select c.id, co.domain, c.company_resolved_at is not null as tried from outreach.candidates c
               left join outreach.companies co on co.id = c.company_id order by c.id`),
    );
    expect(rows.rows).toEqual([
      { id: '801', domain: 'laufshop-mueller.de', tried: true },
      { id: '802', domain: null, tried: true },
    ]);
    calls.length = 0;
    expect(await resolveLeadCompanies(deps, userId, 5, webFetch)).toBe(0);
    expect(calls.length).toBe(0);
  });
});
