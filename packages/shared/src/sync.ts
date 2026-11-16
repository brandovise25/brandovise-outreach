import { z } from 'zod';

// Sync round: matches what the robot read on LinkedIn (connections, sent invitations, inbox list) to
// active prospects. Conservative on purpose: a reply only counts when exactly one active prospect has
// that name and the conversation's date is not older than our last message to them.

// Lenient on purpose (13.11.2026): LinkedIn previews can be longer than expected and lists can be long.
// Texts are cut and lists shortened instead of the whole sync being refused with "invalid request".
const cut = (n: number) => z.string().transform((s) => s.slice(0, n));
const cutOrNull = (n: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s == null ? null : s.slice(0, n)));
const firstN = <T extends z.ZodType>(item: T, n: number) =>
  z
    .array(z.unknown())
    .transform((a) => a.slice(0, n))
    .pipe(z.array(item));

export const SyncPayload = z.object({
  connections: firstN(
    z.object({
      name: cut(200),
      profileUrl: cut(400),
      connectedOn: cutOrNull(80),
      headline: cutOrNull(400).optional(),
    }),
    200,
  ),
  sent: z.object({
    total: z
      .number()
      .nullish()
      .transform((n) => (n == null ? null : Math.round(n))),
    items: firstN(
      z.object({
        name: cut(200),
        profileUrl: cut(400),
        sentDaysAgo: z
          .number()
          .nullish()
          .transform((n) => n ?? null),
      }),
      300,
    ),
  }),
  // Connection requests waiting for Jibran (Invitations received, 16.11.2026): seen here means the
  // person asked. Optional, so an older extension that does not read the page still syncs.
  received: firstN(
    z.object({
      name: cut(200),
      profileUrl: cut(400),
    }),
    200,
  ).default([]),
  inbox: firstN(
    z.object({
      name: cut(200),
      snippet: cut(1000),
      fromMe: z.boolean(),
      unread: z.boolean(),
      time: cutOrNull(40),
      sponsored: z.boolean(),
    }),
    100,
  ),
});
export type SyncPayload = z.infer<typeof SyncPayload>;

export interface SyncTarget {
  id: number;
  name: string;
  url: string | null;
  stage: string;
  invited_at: string | null;
  accepted_at: string | null;
  last_out: string | null;
}

export const slugOf = (url: string | null | undefined): string | null => {
  const m = decodeURIComponent(url ?? '').match(/\/in\/([^/?#]+)/);
  return m ? m[1]!.toLowerCase() : null;
};
const normName = (n: string) =>
  n
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  mär: 2,
  apr: 3,
  may: 4,
  mai: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  okt: 9,
  nov: 10,
  dec: 11,
  dez: 11,
};
const DAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sonntag: 0,
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
};

// The inbox shows "1:21 PM" (today), "Monday" (this week), "Oct 8" / "8. Okt." or "Sep 30, 2025".
export function inboxDate(time: string | null, now = new Date()): Date | null {
  const t = (time ?? '').trim().toLowerCase();
  if (!t) return null;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (/^\d{1,2}:\d{2}(\s?[ap]m)?$/.test(t)) return day(now);
  if (t === 'yesterday' || t === 'gestern') return day(new Date(now.getTime() - 86_400_000));
  if (t in DAYS) {
    const back = (now.getDay() - DAYS[t]! + 7) % 7 || 7;
    return day(new Date(now.getTime() - back * 86_400_000));
  }
  let m = t.match(/^([a-zä]{3})\w*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  let month: number | undefined;
  let date: number | undefined;
  let year: number | undefined;
  if (m) [month, date, year] = [MONTHS[m[1]!], Number(m[2]), m[3] ? Number(m[3]) : undefined];
  else if ((m = t.match(/^(\d{1,2})\.\s*([a-zä]{3})\w*\.?(?:\s*(\d{4}))?$/)))
    [date, month, year] = [Number(m[1]), MONTHS[m[2]!], m[3] ? Number(m[3]) : undefined];
  if (month === undefined || !date) return null;
  const y = year ?? now.getFullYear();
  const d = new Date(y, month, date);
  return !year && d > now ? new Date(y - 1, month, date) : d;
}

export function matchSync(
  targets: SyncTarget[],
  p: Omit<SyncPayload, 'received'>,
  now = new Date(),
) {
  const connected = new Map(p.connections.map((c) => [slugOf(c.profileUrl), c] as const));
  const accepted = targets
    .filter((t) => t.stage === 'invited' && connected.has(slugOf(t.url)))
    .map((t) => {
      const c = connected.get(slugOf(t.url))!;
      return { id: t.id, at: c.connectedOn ? `${c.connectedOn}T12:00:00Z` : null, name: t.name };
    });

  const byName = new Map<string, SyncTarget[]>();
  for (const t of targets) {
    const k = normName(t.name);
    if (k) byName.set(k, [...(byName.get(k) ?? []), t]);
  }
  const replied: { id: number; snippet: string; name: string }[] = [];
  const unsure: string[] = [];
  for (const i of p.inbox) {
    if (i.fromMe || i.sponsored || !i.snippet) continue;
    const hits = byName.get(normName(i.name)) ?? [];
    if (hits.length !== 1) {
      if (hits.length > 1) unsure.push(`${i.name}: ${hits.length} prospects with this name`);
      continue;
    }
    const t = hits[0]!;
    const when = inboxDate(i.time, now);
    const lastOut = t.last_out ? new Date(t.last_out) : null;
    if (!when) {
      unsure.push(`${i.name}: no readable date ("${i.time ?? ''}")`);
      continue;
    }
    // a conversation older than our last outgoing step is not a new reply
    if (lastOut && when < new Date(lastOut.getFullYear(), lastOut.getMonth(), lastOut.getDate()))
      continue;
    replied.push({ id: t.id, snippet: i.snippet.slice(0, 500), name: t.name });
  }
  return { accepted, replied, unsure, pending: p.sent.total };
}
