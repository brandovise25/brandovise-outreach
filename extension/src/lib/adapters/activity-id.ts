// LinkedIn's feed shows no post links, but post cards carry an id/componentkey with the post id:
// base64 of a small protobuf whose varint value is 2 × the id.
//   "CgsI…" (field 1) = urn:li:activity:<id>   "EgsI…" (field 2) = urn:li:ugcPost:<id>
// Verified 09.10.2026 on a recent-activity page against urn:li:comment:(activity:N,…) and
// (ugcPost:N,…): every decoded value matched exactly. The id's upper bits are its creation time, which
// is checked so a changed format is ignored instead of producing a wrong link.

const KEY = /^(CgsI|EgsI)[A-Za-z0-9_+/-]+/;
const KIND: Record<number, 'activity' | 'ugcPost'> = { 0x0a: 'activity', 0x12: 'ugcPost' };

function bytesOf(b64: string): number[] | null {
  try {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    return Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function varint(b: number[], i: number): [bigint, number] | null {
  let v = 0n;
  let shift = 0n;
  while (i < b.length) {
    const x = b[i++]!;
    v |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) return [v, i];
    shift += 7n;
  }
  return null;
}

// "urn:li:activity:<id>" / "urn:li:ugcPost:<id>" from a card key, or null.
export function postUrnFromKey(key: string, now = Date.now()): string | null {
  const m = key.match(KEY)?.[0];
  if (!m) return null;
  const b = bytesOf(m.slice(0, 18)); // 4 + 14 chars = the 13 bytes of the message
  const kind = b ? KIND[b[0]!] : undefined;
  if (!b || !kind || b[2] !== 0x08) return null;
  const r = varint(b, 3);
  if (!r || r[0] % 2n !== 0n) return null;
  const id = r[0] / 2n;
  const ms = Number(id >> 22n); // creation time in ms since 1970
  if (ms < Date.UTC(2015, 0, 1) || ms > now + 86_400_000) return null;
  return `urn:li:${kind}:${id.toString()}`;
}

export function activityIdFromKey(key: string, now = Date.now()): string | null {
  const urn = postUrnFromKey(key, now);
  return urn?.startsWith('urn:li:activity:') ? urn.slice('urn:li:activity:'.length) : null;
}

const KEYED = '[id^="CgsI"], [componentkey^="CgsI"], [id^="EgsI"], [componentkey^="EgsI"]';

// The post's URN for a card element (the card itself or anything inside it, comments excluded).
export function postUrnIn(el: Element): string | null {
  const candidates = [el, ...Array.from(el.querySelectorAll(KEYED))].filter(
    (e) => e === el || !e.closest(COMMENT_AREA),
  );
  for (const e of candidates) {
    for (const k of [e.getAttribute('id'), e.getAttribute('componentkey')]) {
      const urn = k ? postUrnFromKey(k) : null;
      if (urn) return urn;
    }
  }
  // Older pages: a real permalink or data-urn.
  const raw =
    el.closest('[data-urn^="urn:li:"]')?.getAttribute('data-urn') ??
    el
      .querySelector('[data-urn^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"]')
      ?.getAttribute('data-urn') ??
    el.querySelector('a[href*="/feed/update/urn:li:"]')?.getAttribute('href');
  return raw?.match(/urn:li:(?:activity|ugcPost|share):\d+/)?.[0] ?? null;
}

// Comment sections inside a post card (their reactions/menus must not be read as posts).
export const COMMENT_AREA =
  '[componentkey^="commentsSectionContainer"], [componentkey^="CommentComponentReference"], [id^="replaceableComment_"], .comments-comments-list, .comments-comment-item';

export const postLink = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;
