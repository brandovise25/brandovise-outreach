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
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: EMAIL, password: PASSWORD, deviceId: DEVICE_ID },
  });
  token = res.json().accessToken;
});

const get = (url: string, version = '0.1.0') =>
  app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, 'x-extension-version': version },
  });

describe('ext routes', () => {
  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('records a heartbeat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ext/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: DEVICE_ID,
        name: 'MacBook',
        version: '0.1.0',
        userAgent: 'test',
        lastError: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const rows = await owner((c) => c.query('select name, version from outreach.ext_devices'));
    expect(rows.rows).toEqual([{ name: 'MacBook', version: '0.1.0' }]);
  });

  it('refuses a heartbeat for another device id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ext/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        deviceId: '22222222-2222-4222-8222-222222222222',
        name: 'x',
        version: '0.1.0',
        userAgent: 'x',
        lastError: null,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns settings with dry-run on and send disabled by default', async () => {
    const res = await get('/ext/settings');
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.ext_dry_run).toBe(true);
    expect(s.ext_enabled_actions).not.toContain('send');
    expect(s.run_caps).toEqual({ max_profile_visits: 12, max_page_loads: 25 });
    expect(s.paused).toBe(false);
  });

  it('rejects an extension below ext_min_version', async () => {
    await owner((c) =>
      c.query(`update outreach.settings set value = '0.2.0' where key = 'ext_min_version'`),
    );
    expect((await get('/ext/settings', '0.1.9')).statusCode).toBe(426);
    expect((await get('/ext/settings', '0.2.0')).statusCode).toBe(200);
  });

  it('serves allowed docs only', async () => {
    expect((await get('/ext/docs/browsing_conduct')).json()).toEqual({
      key: 'browsing_conduct',
      body: 'test conduct',
    });
    expect((await get('/ext/docs/secret_stuff')).statusCode).toBe(404);
  });

  it('returns limits', async () => {
    const res = await get('/ext/limits');
    expect(res.statusCode).toBe(200);
    expect(res.json().invite_status).toBe('open');
  });
});
