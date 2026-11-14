import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockedUrl, checkUrl, fetchPublic, isPublicAddress } from '../src/web/public-http.ts';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.9',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    'not-an-ip',
  ])('blocks %s', (a) => expect(isPublicAddress(a)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8'])(
    'allows %s',
    (a) => expect(isPublicAddress(a)).toBe(true),
  );
});

describe('checkUrl', () => {
  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'http://user:pw@example.com/',
    'http://localhost/',
    'http://db.localhost/',
    'http://printer.local/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://example.com:8080/',
    'nonsense',
  ])('refuses %s', (u) => expect(() => checkUrl(u)).toThrow(BlockedUrl));
  it('accepts a normal site', () =>
    expect(checkUrl('https://www.example.de/impressum').hostname).toBe('www.example.de'));
});

describe('fetchPublic', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') return void res.end('x'.repeat(5000));
      if (req.url === '/to-internal')
        return void res.writeHead(302, { location: 'http://internal.test/secret' }).end();
      if (req.url === '/to-meta')
        return void res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
      if (req.url === '/loop') return void res.writeHead(302, { location: '/loop' }).end();
      if (req.url === '/hop') return void res.writeHead(301, { location: '/page' }).end();
      if (req.url === '/blocked') return void res.writeHead(403).end('no');
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(`<html>ok ${req.headers['user-agent']}</html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // In these tests "shop.test" is the public site (served locally) and "internal.test" is a private host.
  const opts = {
    anyPort: true,
    resolve: async (h: string) => [
      { address: h === 'internal.test' ? '10.0.0.5' : '127.0.0.1', family: 4 },
    ],
    isPublic: (a: string) => a === '127.0.0.1',
  };
  const url = (path: string) => `http://shop.test:${port}${path}`;

  it('reads a page, follows a redirect and says who it is', async () => {
    const r = await fetchPublic(url('/hop'), opts);
    expect(r.status).toBe(200);
    expect(r.url).toBe(url('/page'));
    expect(r.body).toMatch(/BrandoviseLeadReader/);
  });
  it('refuses a host that resolves to a private address', async () => {
    await expect(fetchPublic(`http://internal.test:${port}/`, opts)).rejects.toThrow(/non-public/);
    await expect(fetchPublic(url('/page'), { ...opts, isPublic: () => false })).rejects.toThrow(
      /non-public/,
    );
  });
  it('refuses a redirect to a private host or address', async () => {
    await expect(fetchPublic(url('/to-internal'), opts)).rejects.toThrow(/non-public/);
    await expect(fetchPublic(url('/to-meta'), opts)).rejects.toThrow(BlockedUrl);
  });
  it('stops after too many redirects and cuts oversized pages', async () => {
    await expect(fetchPublic(url('/loop'), opts)).rejects.toThrow(/too many redirects/);
    const big = await fetchPublic(url('/big'), { ...opts, maxBytes: 1000 });
    expect(big.body.length).toBe(1000);
    expect(big.truncated).toBe(true);
  });
  it('returns a 403 as an answer (the caller stops for that site)', async () => {
    expect((await fetchPublic(url('/blocked'), opts)).status).toBe(403);
  });
});
