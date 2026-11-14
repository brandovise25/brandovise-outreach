import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { makeApp } from './helpers.ts';

const built = existsSync(new URL('../../web/dist/index.html', import.meta.url));
const { app, db } = await makeApp();
afterAll(async () => {
  await app.close();
  await db.end();
});

describe.skipIf(!built)('web app', () => {
  it('serves the app with a CSP that only lets the server and the extension embed it', async () => {
    const res = await app.inject({ method: 'GET', url: '/app/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root">');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'self' chrome-extension://abc");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('redirects / and /app to /app/', async () => {
    expect((await app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/app/');
    expect((await app.inject({ method: 'GET', url: '/app' })).headers.location).toBe('/app/');
  });
});
