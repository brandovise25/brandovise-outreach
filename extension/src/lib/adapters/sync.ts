import { readText } from './text.ts';

// Readers for the sync round (read-only): recent connections, sent invitations, the inbox list.
// Stable hooks seen 09.10.2026 (captures in fixtures/raw):
//   connections: [componentkey^="ConnectionCard_"], "Connected on <date>", a[aria-label^="Send a message to"]
//                (its href carries profileUrn=urn:li:fsd_profile:…), total "3,663 connections"
//   sent:        a[aria-label^="Withdraw invitation sent to"], "Sent 5 days ago", total "People 331"
//                on the People tab link (before 02.11.2026: "People (328)")
//   inbox:       li.msg-conversation-listitem, …__participant-names, …-card__message-snippet ("You: …"),
//                …-card__unread-count, …__time-stamp

export interface Connection {
  name: string;
  profileUrl: string;
  profileUrn: string | null; // urn:li:fsd_profile:ACoAA…
  headline: string | null;
  connectedOn: string | null; // YYYY-MM-DD
}
export interface SentInvitation {
  name: string;
  profileUrl: string;
  headline: string | null;
  sentText: string | null; // "Sent 5 days ago"
  sentDaysAgo: number | null; // approximate
}
export interface InboxItem {
  name: string;
  snippet: string;
  fromMe: boolean; // the last message is Jibran's ("You: …")
  unread: boolean;
  time: string | null; // as shown: "Oct 8", "1:21 PM", "Monday"
  sponsored: boolean;
}

function profileUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const m = new URL(href, 'https://www.linkedin.com').pathname.match(/^\/in\/[^/]+/);
    return m ? `https://www.linkedin.com${decodeURI(m[0])}/` : null;
  } catch {
    return null;
  }
}
const lines = (el: Element) =>
  readText(el)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
const count = (text: string, re: RegExp) => {
  const m = text.match(re);
  return m ? Number(m[1]!.replace(/[.,]/g, '')) : null;
};

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
export function parseConnectedOn(text: string): string | null {
  const m = text.match(/Connected on (\w+) (\d{1,2}), (\d{4})/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

export function parseSentAgo(text: string): number | null {
  const t = text.toLowerCase();
  if (/sent today|just now/.test(t)) return 0;
  if (/yesterday/.test(t)) return 1;
  const m = t.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  return (
    { minute: 0, hour: 0, day: n, week: n * 7, month: n * 30, year: n * 365 }[m[2] as 'day'] ?? null
  );
}

export function readConnections(doc: Document): { total: number | null; items: Connection[] } {
  const items: Connection[] = [];
  const seen = new Set<string>();
  for (const card of Array.from(doc.querySelectorAll('[componentkey^="ConnectionCard_"]'))) {
    const link = card.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
    const url = profileUrl(link?.getAttribute('href') ?? null);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const msg = card.querySelector('a[aria-label^="Send a message to"]');
    const urn =
      decodeURIComponent(msg?.getAttribute('href') ?? '').match(/urn:li:fsd_profile:[\w-]+/)?.[0] ??
      null;
    const name =
      msg
        ?.getAttribute('aria-label')
        ?.replace(/^Send a message to /, '')
        .trim() ??
      lines(card)[0] ??
      '';
    const ls = lines(card).filter((l) => l !== name && !/^(Message|Nachricht)$/.test(l));
    const connected = ls.find((l) => /^Connected on /i.test(l)) ?? null;
    items.push({
      name,
      profileUrl: url,
      profileUrn: urn,
      headline: ls.find((l) => l !== connected) ?? null,
      connectedOn: connected ? parseConnectedOn(connected) : null,
    });
  }
  return { total: count(readText(doc.body), /([\d.,]+)\s+connections/i), items };
}

export function readSentInvitations(doc: Document): {
  total: number | null;
  items: SentInvitation[];
} {
  const items: SentInvitation[] = [];
  const seen = new Set<string>();
  for (const w of Array.from(doc.querySelectorAll('[aria-label^="Withdraw invitation sent to"]'))) {
    const name = w
      .getAttribute('aria-label')!
      .replace(/^Withdraw invitation sent to /, '')
      .trim();
    // the item: the nearest ancestor that also holds the person's profile link
    let item: Element | null = w.parentElement;
    while (item && !item.querySelector('a[href*="/in/"]')) item = item.parentElement;
    const url = profileUrl(item?.querySelector('a[href*="/in/"]')?.getAttribute('href') ?? null);
    if (!item || !url || seen.has(url)) continue;
    seen.add(url);
    const ls = lines(item).filter((l) => l !== name && !/^(Withdraw|Zurückziehen)$/.test(l));
    const sent = ls.find((l) => /^Sent\b|ago$|yesterday|today/i.test(l)) ?? null;
    items.push({
      name,
      profileUrl: url,
      headline: ls.find((l) => l !== sent && !/show more|…more/i.test(l)) ?? null,
      sentText: sent,
      sentDaysAgo: sent ? parseSentAgo(sent) : null,
    });
  }
  // The total: "People 331" on the People tab since about 02.11.2026 (before: "People (328)").
  // Without it the robot stops inviting after 2 days (pending_unknown), so read the tab first.
  const tab = doc.querySelector('a[href*="invitation-manager/sent/CONNECTION"]');
  const TOTAL = /\b(?:People|Personen)\s*\(?\s*([\d.,]+)\s*\)?/;
  const total = (tab && count(readText(tab), TOTAL)) ?? count(readText(doc.body), TOTAL);
  return { total, items };
}

// Invitations received (16.11.2026): who sent Jibran a connection request that is still waiting for
// his click. Read only; the robot never accepts or ignores. Each invitation is a list item
// (componentkey "urn:li:invitation:…") with a "View <name>’s profile" link and Accept/Ignore controls.
// Event, page, group and newsletter invitations ("invited you to …") are counted but not returned.
export interface ReceivedInvitation {
  name: string;
  profileUrl: string;
}
export function readReceivedInvitations(doc: Document): {
  items: ReceivedInvitation[];
  other: number;
} {
  const items: ReceivedInvitation[] = [];
  const seen = new Set<string>();
  let other = 0;
  const rows = Array.from(
    doc.querySelectorAll('[role="listitem"][componentkey^="urn:li:invitation:"]'),
  );
  for (const row of rows) {
    const text = readText(row);
    const hasAccept = !!Array.from(row.querySelectorAll('button, a')).find((b) =>
      /^(Accept|Annehmen)\b/i.test(b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''),
    );
    const link = row.querySelector('a[href*="/in/"]');
    const url = profileUrl(link?.getAttribute('href') ?? null);
    if (!hasAccept || !url || /invited you to|hat Sie zu|lädt Sie|eingeladen/i.test(text)) {
      other++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const label = link?.getAttribute('aria-label') ?? '';
    const name =
      label.match(/^View (.+?)[’']s profile$/i)?.[1] ??
      label.match(/^Profil von (.+?) anzeigen$/i)?.[1] ??
      readText(link!).split('\n')[0]!.trim();
    items.push({ name, profileUrl: url });
  }
  return { items, other };
}

export function readInbox(doc: Document): InboxItem[] {
  const items: InboxItem[] = [];
  for (const li of Array.from(doc.querySelectorAll('li.msg-conversation-listitem'))) {
    const text = (sel: string) =>
      (li.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const name = text('.msg-conversation-listitem__participant-names');
    if (!name) continue; // placeholder rows that are not rendered yet
    const raw = text('.msg-conversation-card__message-snippet');
    const fromMe = /^You:/.test(raw);
    // "You: …" for Jibran's own last message, "<First name>: …" for theirs.
    const first = name.split(' ')[0]!;
    const snippet = raw
      .replace(/^You:\s*/, '')
      .replace(new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '');
    items.push({
      name,
      snippet,
      fromMe,
      unread:
        !!li.querySelector('.msg-conversation-card__unread-count') ||
        !!li.querySelector('.msg-conversation-card__message-snippet--unread'),
      time: text('.msg-conversation-listitem__time-stamp') || null,
      sponsored: /Sponsored|LinkedIn Offer|Gesponsert/i.test(li.textContent ?? ''),
    });
  }
  return items;
}
