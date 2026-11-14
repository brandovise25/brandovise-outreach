import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, EMAIL, PASSWORD, makeApp, owner, resetData } from './helpers.ts';

const { app, db } = await makeApp();
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(resetData);

const login = (password = PASSWORD, email = EMAIL) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, deviceId: DEVICE_ID },
  });

describe('auth', () => {
  it('logs in and returns a token pair', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
    expect(res.json().refreshToken).toBeTypeOf('string');
  });

  it('rejects a wrong password and an unknown email the same way', async () => {
    const a = await login('wrong password!!');
    const b = await login(PASSWORD, 'nobody@example.com');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('stores only the hash of the refresh token', async () => {
    const { refreshToken } = (await login()).json();
    const rows = await owner((c) => c.query('select token_hash from outreach.refresh_tokens'));
    expect(rows.rows[0].token_hash).not.toBe(refreshToken);
    expect(rows.rows[0].token_hash).toHaveLength(64);
  });

  const refresh = (refreshToken: string) =>
    app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

  it('rotates refresh tokens and revokes all on reuse', async () => {
    const first = (await login()).json();
    const r1 = await refresh(first.refreshToken);
    expect(r1.statusCode).toBe(200);
    const second = r1.json();
    const r2 = await refresh(second.refreshToken);
    expect(r2.statusCode).toBe(200);
    const third = r2.json();

    // The replacement of the first token was used, so presenting the first again is theft:
    // rejected, and the newest token dies too.
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
    expect((await refresh(third.refreshToken)).statusCode).toBe(401);
  });

  it('survives a lost refresh answer: the old token works once more if its replacement was never used', async () => {
    const first = (await login()).json();
    const lost = (await refresh(first.refreshToken)).json(); // answer never reached the extension
    const retry = await refresh(first.refreshToken);
    expect(retry.statusCode).toBe(200);
    // The unused replacement is retired; the retry's token carries on.
    expect((await refresh(retry.json().refreshToken)).statusCode).toBe(200);
    expect((await refresh(lost.refreshToken)).statusCode).toBe(401);
  });

  it('does not bring back a logged-out token', async () => {
    const first = (await login()).json();
    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: first.refreshToken },
    });
    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { refreshToken } = (await login()).json();
    await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken } });
    const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(r.statusCode).toBe(401);
  });

  it('blocks a disabled user even with a valid access token', async () => {
    const { accessToken } = (await login()).json();
    await owner((c) => c.query('update outreach.app_users set enabled = false'));
    const res = await app.inject({
      method: 'GET',
      url: '/ext/limits',
      headers: { authorization: `Bearer ${accessToken}`, 'x-extension-version': '0.1.0' },
    });
    expect(res.statusCode).toBe(403);
  });
});
