import type { ApiClient } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { Connection, InboxItem, SentInvitation } from './adapters/sync.ts';

// Sync round (read-only): the robot tab opens recent connections, sent invitations and the inbox list,
// reads them at reading pace, and the server updates the prospects (accepted, replied, pending count).
// Nothing is clicked except scrolling; inbox threads are not opened, so nothing is marked as read.

const PAGES = {
  connections: 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  sent: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
  inbox: 'https://www.linkedin.com/messaging/',
};

async function readThrough(run: JobRun, tab: RobotTab, steps: number) {
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 7000, 'reading');
  }
}

export async function runSyncRound(
  deps: { api: ApiClient },
  run: JobRun,
): Promise<{ state: string; message: string }> {
  return withRobotTab(run, PAGES.connections, async (tab) => {
    await run.log('Reading your recent connections', {
      step: 'connections',
      progress: { pages: 1, maxPages: 3 },
    });
    await readThrough(run, tab, 3);
    const con = await tab.send<{ total: number | null; items: Connection[] }>({
      type: 'readConnections',
    });
    await run.log(`Connections: ${con.items.length} recent (of ${con.total ?? '?'})`);

    await run.wait(20_000, 45_000, 'between pages');
    await tab.goto(PAGES.sent, 'Opening sent invitations');
    await readThrough(run, tab, 2);
    const sent = await tab.send<{ total: number | null; items: SentInvitation[] }>({
      type: 'readSent',
    });
    await run.log(`Sent invitations: ${sent.total ?? '?'} pending (${sent.items.length} read)`, {
      progress: { pages: 2 },
    });

    await run.wait(20_000, 45_000, 'between pages');
    await tab.goto(PAGES.inbox, 'Opening the inbox (threads are not opened)');
    await readThrough(run, tab, 2);
    const inbox = await tab.send<{ items: InboxItem[] }>({ type: 'readInbox' });
    await run.log(
      `Inbox: ${inbox.items.length} conversations, ${inbox.items.filter((i) => i.unread).length} unread`,
      {
        progress: { pages: 3 },
      },
    );

    const r = (await deps.api.panel('POST', '/ext/sync', {
      jobId: run.id,
      connections: con.items.map((c) => ({
        name: c.name,
        profileUrl: c.profileUrl,
        connectedOn: c.connectedOn,
      })),
      sent: {
        total: sent.total,
        items: sent.items.map((s) => ({
          name: s.name,
          profileUrl: s.profileUrl,
          sentDaysAgo: s.sentDaysAgo,
        })),
      },
      inbox: inbox.items.map((i) => ({
        name: i.name,
        snippet: i.snippet,
        fromMe: i.fromMe,
        unread: i.unread,
        time: i.time,
        sponsored: i.sponsored,
      })),
    })) as {
      accepted: number;
      replied: number;
      pending: number | null;
      acceptedNames: string[];
      repliedNames: string[];
      unsure: string[];
    };
    if (r.acceptedNames.length) await run.log(`Accepted: ${r.acceptedNames.join(', ')}`);
    if (r.repliedNames.length) await run.log(`New replies: ${r.repliedNames.join(', ')}`);
    for (const u of r.unsure.slice(0, 5)) await run.log(`Not matched: ${u}`, { level: 'warn' });
    return {
      state: 'done',
      message: `Synced: ${r.accepted} accepted, ${r.replied} new repl${r.replied === 1 ? 'y' : 'ies'}, ${r.pending ?? '?'} invites pending.`,
    };
  });
}
