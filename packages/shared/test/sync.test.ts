import { describe, expect, it } from 'vitest';
import { inboxDate, matchSync, type SyncTarget } from '../src/sync.ts';

const now = new Date(2026, 9, 11, 15, 0); // Sunday 11.10.2026
const t = (x: Partial<SyncTarget>): SyncTarget => ({
  id: 1,
  name: 'Anna Muster',
  url: 'https://www.linkedin.com/in/anna-muster/',
  stage: 'invited',
  invited_at: '2026-10-01T10:00:00Z',
  accepted_at: null,
  last_out: '2026-10-01T10:00:00Z',
  ...x,
});
const empty = { connections: [], sent: { total: 328, items: [] }, inbox: [] };

describe('inbox dates', () => {
  it('reads the formats LinkedIn shows', () => {
    expect(inboxDate('1:21 PM', now)?.getDate()).toBe(11);
    expect(inboxDate('Oct 8', now)?.toDateString()).toBe(new Date(2026, 9, 8).toDateString());
    expect(inboxDate('Monday', now)?.getDate()).toBe(5);
    expect(inboxDate('8. Okt.', now)?.getMonth()).toBe(9);
    expect(inboxDate('Dec 30', now)?.getFullYear()).toBe(2025); // not in the future
    expect(inboxDate('Sep 30, 2025', now)?.getFullYear()).toBe(2025);
    expect(inboxDate('', now)).toBeNull();
  });
});

describe('matching', () => {
  it('an invited prospect in the connections list has accepted', () => {
    const r = matchSync(
      [t({}), t({ id: 2, url: 'https://www.linkedin.com/in/other/' })],
      {
        ...empty,
        connections: [
          {
            name: 'Anna Muster',
            profileUrl: 'https://www.linkedin.com/in/Anna-Muster/',
            connectedOn: '2026-10-08',
          },
        ],
      },
      now,
    );
    expect(r.accepted).toEqual([{ id: 1, at: '2026-10-08T12:00:00Z', name: 'Anna Muster' }]);
  });
  it('a new incoming message counts as a reply; old ones, own ones, ads and ambiguous names do not', () => {
    const inbox = (name: string, time: string, fromMe = false, sponsored = false) => ({
      name,
      snippet: 'Danke, gerne mehr dazu',
      fromMe,
      unread: true,
      time,
      sponsored,
    });
    const targets = [
      t({ stage: 'msg1_sent', last_out: '2026-10-05T10:00:00Z' }),
      t({ id: 3, name: 'Ben Doppelt' }),
      t({ id: 4, name: 'Ben Doppelt' }),
    ];
    const r = matchSync(
      targets,
      {
        ...empty,
        inbox: [
          inbox('Anna Muster', 'Oct 8'),
          inbox('Ben Doppelt', 'Oct 9'),
          inbox('Anna Muster', 'Oct 8', true),
          inbox('LinkedIn Offer', 'Oct 8', false, true),
        ],
      },
      now,
    );
    expect(r.replied.map((x) => x.id)).toEqual([1]);
    expect(r.unsure[0]).toMatch(/Ben Doppelt: 2 prospects/);
    const old = matchSync(
      [t({ stage: 'msg1_sent', last_out: '2026-10-09T10:00:00Z' })],
      { ...empty, inbox: [inbox('Anna Muster', 'Oct 8')] },
      now,
    );
    expect(old.replied).toEqual([]);
  });
});

describe('SyncPayload is lenient about size', () => {
  it('cuts long texts and long lists instead of refusing the sync', async () => {
    const { SyncPayload } = await import('../src/sync.ts');
    const p = SyncPayload.parse({
      connections: [{ name: 'A', profileUrl: 'u' }],
      sent: { total: 336.0, items: [{ name: 'B', profileUrl: 'u', sentDaysAgo: null }] },
      inbox: Array.from({ length: 140 }, (_, i) => ({
        name: `N${i}`,
        snippet: 'x'.repeat(1500),
        fromMe: false,
        unread: true,
        time: 'Wednesday, 12 November 2026 at 10:32 in the morning',
        sponsored: false,
      })),
    });
    expect(p.inbox.length).toBe(100);
    expect(p.inbox[0]!.snippet.length).toBe(1000);
    expect(p.inbox[0]!.time!.length).toBe(40);
    expect(p.connections[0]!.connectedOn).toBeNull();
    expect(() =>
      SyncPayload.parse({
        connections: [],
        sent: { total: null, items: [] },
        inbox: [{ name: 1 }],
      }),
    ).toThrow();
  });
});
