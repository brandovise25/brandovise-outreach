import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';
import { getSecret, open, seal } from '../src/secrets.ts';
import { runCompanyQueue } from '../src/web/company-worker.ts';
import type { CompanyProfile } from '../src/web/profile-company.ts';
import type { AppDeps } from '../src/app.ts';

const { app, db } = await makeApp();
let token = '';
let userId = '';
afterAll(async () => {
  await app.close();
  await db.end();
});
const h = () => ({ authorization: `Bearer ${token}` });
const deps = { db, config: { JWT_SECRET: 'x'.repeat(40) } } as unknown as AppDeps;
beforeEach(async () => {
  await resetData();
  await owner((c) =>
    c.query(
      `delete from outreach.secrets; delete from outreach.candidates; delete from outreach.prospects where company_id is not null; delete from outreach.companies`,
    ),
  );
  token = (
    await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
    })
  ).json().accessToken;
  userId = (await owner((c) => c.query(`select id from outreach.app_users limit 1`))).rows[0].id;
});

const fake =
  (over: Partial<CompanyProfile>) =>
  async (domain: string): Promise<CompanyProfile> => ({
    domain,
    homeUrl: `https://${domain}/`,
    blocked: false,
    error: null,
    pages: [`https://${domain}/`],
    impressum: null,
    observations: [
      {
        code: 'SHOP_PLATFORM',
        value_text: 'Shopify',
        value_num: null,
        confidence: 0.95,
        evidence_url: `https://${domain}/`,
      },
      {
        code: 'SUPPORT_WHATSAPP',
        value_text: null,
        value_num: 1,
        confidence: 0.95,
        evidence_url: `https://${domain}/`,
      },
      {
        code: 'OWNER_NAME',
        value_text: 'Max Mustermann (Geschäftsführer)',
        value_num: null,
        confidence: 0.85,
        evidence_url: `https://${domain}/impressum`,
      },
    ],
    ...over,
  });

describe('companies and signals', () => {
  it('adds pasted websites once, reads them, lists them with a cohort filter and shows signals on a lead', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/panel/companies',
      headers: h(),
      payload: {
        text: 'https://www.Shop-Eins.de/pages/x\nshop-zwei.de, info@shop-drei.de\nhttps://www.linkedin.com/in/x\nshop-eins.de',
      },
    });
    expect(add.json()).toMatchObject({ found: 2, added: 2, known: 0 });
    let n = 0;
    await runCompanyQueue(deps, 5, (d) =>
      fake(d === 'shop-zwei.de' ? { blocked: true, pages: [], observations: [] } : {})(d).then(
        (p) => (n++, p),
      ),
    );
    expect(n).toBe(2);

    const all = (await app.inject({ method: 'GET', url: '/panel/companies', headers: h() })).json();
    expect(all.counts).toMatchObject({ all: 2, profiled: 1, blocked: 1, with_owner: 1 });
    const cohort = (
      await app.inject({
        method: 'GET',
        url: '/panel/companies?codes=SHOP_PLATFORM,SUPPORT_WHATSAPP',
        headers: h(),
      })
    ).json();
    expect(cohort.items.map((x: { domain: string }) => x.domain)).toEqual(['shop-eins.de']);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/panel/companies?codes=SHOP_PLATFORM,CHAT_WIDGET',
          headers: h(),
        })
      ).json().items,
    ).toEqual([]);

    // a lead of that company carries the signals
    const id = cohort.items[0].id;
    await owner((c) =>
      c.query(
        `insert into outreach.candidates (full_name, linkedin_url, verdict, company_id) values ('Max Mustermann', 'https://www.linkedin.com/in/max-m/', 'staged', $1)`,
        [id],
      ),
    );
    const leads = (await app.inject({ method: 'GET', url: '/panel/leads', headers: h() })).json();
    expect(leads[0].company_domain).toBe('shop-eins.de');
    expect(leads[0].signals.map((s: { code: string }) => s.code)).toEqual(
      expect.arrayContaining(['SHOP_PLATFORM', 'SUPPORT_WHATSAPP']),
    );
  });

  it('stores a key encrypted, shows only a hint, and can clear it', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/panel/secrets/serper_api_key',
      headers: h(),
      payload: { value: 'abcd1234secretKEY9876' },
    });
    expect(set.json()).toEqual({ ok: true, set: true });
    const status = (
      await app.inject({ method: 'GET', url: '/panel/secrets', headers: h() })
    ).json();
    expect(status.serper_api_key.hint).toBe('…9876');
    expect(JSON.stringify(status)).not.toMatch(/secretKEY/);
    const row = (await owner((c) => c.query(`select value from outreach.secrets`))).rows[0]
      .value as string;
    expect(row).toMatch(/^v1:/);
    expect(row).not.toMatch(/secretKEY/);
    expect(open(deps, seal(deps, 'hello'))).toBe('hello');
    const other = { ...deps, config: { JWT_SECRET: 'y'.repeat(40) } } as unknown as AppDeps;
    expect(open(other, seal(deps, 'hello'))).toBeNull();
    // only the server secret that sealed it can read it back
    expect(await getSecret(deps, userId, 'serper_api_key')).toBe('abcd1234secretKEY9876');
    expect(await getSecret(other, userId, 'serper_api_key')).toBeNull();
    await app.inject({
      method: 'POST',
      url: '/panel/secrets/serper_api_key',
      headers: h(),
      payload: { value: '' },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/panel/secrets', headers: h() })).json(),
    ).toEqual({});
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/panel/secrets/other_key',
          headers: h(),
          payload: { value: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
