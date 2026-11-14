import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

// Reads public web pages of companies (homepage, Impressum, contact, careers, sitemap) for the lead
// signals (Jibran, 13.11.2026). The server must never be talked into fetching something internal, so:
//  - only http(s), default ports, no credentials in the URL;
//  - every address a host resolves to must be public, and the connection is made to exactly the address
//    that was checked (the check sits in the socket's own lookup, so DNS cannot change in between);
//  - every redirect hop goes through the same checks, at most 5 hops;
//  - time limit and size limit per page; no proxy from the environment.
// A 403, 429 or bot challenge is an answer like any other: the caller stops for that site, nothing is
// retried in disguise. The user agent says who we are.

export const USER_AGENT =
  'BrandoviseLeadReader/1.0 (+https://brandovise.com; reads a few public company pages)';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3], // multicast and reserved (224.0.0.0 - 255.255.255.255)
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127], // :: and ::1
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/i.test(address)) return false; // mapped address in hex form
  return !blocked.check(address, 'ipv6');
}

export class BlockedUrl extends Error {}

export function checkUrl(
  raw: string,
  o: { isPublic?: (a: string) => boolean; anyPort?: boolean } = {},
): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrl('not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrl('only http(s)');
  if (u.username || u.password) throw new BlockedUrl('credentials in the URL');
  if (!o.anyPort && u.port && u.port !== '80' && u.port !== '443')
    throw new BlockedUrl('unusual port');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new BlockedUrl('local host name');
  if (isIP(host) && !(o.isPublic ?? isPublicAddress)(host))
    throw new BlockedUrl('not a public address');
  if (!isIP(host) && !host.includes('.')) throw new BlockedUrl('not a public host name');
  return u;
}

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolve: Resolve = (host) =>
  new Promise((ok, fail) =>
    dnsLookup(host, { all: true }, (err, list) => (err ? fail(err) : ok(list))),
  );

export interface PageResult {
  url: string; // after redirects
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}
export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  // Tests only: how names resolve, which addresses count as public, and ports other than 80/443.
  resolve?: Resolve;
  isPublic?: (address: string) => boolean;
  anyPort?: boolean;
}

function once(
  u: URL,
  o: Required<FetchOptions>,
): Promise<PageResult & { location: string | null }> {
  return new Promise((ok, fail) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        agent: false, // a checked connection is never reused for another host
        timeout: o.timeoutMs,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8',
          'accept-language': 'de,en;q=0.8',
          'accept-encoding': 'identity',
        },
        // The address the socket connects to is the one that passed the check.
        // Node may ask for one address or for all of them (opts.all).
        lookup: (host, lookupOpts, cb) => {
          const done = cb as (e: Error | null, a?: unknown, f?: number) => void;
          o.resolve(host).then(
            (list) => {
              if (!list.length || list.some((a) => !o.isPublic(a.address)))
                return done(new BlockedUrl(`${host} resolves to a non-public address`));
              const pick = list.find((a) => a.family === 4) ?? list[0]!;
              if ((lookupOpts as { all?: boolean }).all) done(null, [pick]);
              else done(null, pick.address, pick.family);
            },
            (err: Error) => done(err),
          );
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > o.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () =>
          ok({
            url: u.toString(),
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            location: typeof res.headers.location === 'string' ? res.headers.location : null,
          });
        res.on('end', done);
        res.on('close', done);
        res.on('error', () => done());
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', fail);
    req.end();
  });
}

export async function fetchPublic(rawUrl: string, opts: FetchOptions = {}): Promise<PageResult> {
  const o: Required<FetchOptions> = {
    timeoutMs: opts.timeoutMs ?? 8000,
    maxBytes: opts.maxBytes ?? 1_500_000,
    maxRedirects: opts.maxRedirects ?? 5,
    resolve: opts.resolve ?? systemResolve,
    isPublic: opts.isPublic ?? isPublicAddress,
    anyPort: opts.anyPort ?? false,
  };
  let url = checkUrl(rawUrl, o);
  for (let hop = 0; ; hop++) {
    const r = await once(url, o);
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (hop >= o.maxRedirects) throw new Error('too many redirects');
      url = checkUrl(new URL(r.location, url).toString(), o);
      continue;
    }
    return {
      url: r.url,
      status: r.status,
      contentType: r.contentType,
      body: r.body,
      truncated: r.truncated,
    };
  }
}
