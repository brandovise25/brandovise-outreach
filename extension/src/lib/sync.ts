import type { ApiClient } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { Connection, InboxItem, SentInvitation } from './adapters/sync.ts';
import type { ExperienceItem, ProfileTop } from './adapters/profile.ts';

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
        headline: c.headline,
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
      inboundAdded?: number;
      inboundToCheck?: { url: string; name: string }[];
    };
    if (r.acceptedNames.length) await run.log(`Accepted: ${r.acceptedNames.join(', ')}`);
    if (r.repliedNames.length) await run.log(`New replies: ${r.repliedNames.join(', ')}`);
    for (const u of r.unsure.slice(0, 5)) await run.log(`Not matched: ${u}`, { level: 'warn' });
    const inbound = await checkInbound(deps, run, tab, r.inboundToCheck ?? []);
    return {
      state: 'done',
      message: `Synced: ${r.accepted} accepted, ${r.replied} new repl${r.replied === 1 ? 'y' : 'ies'}, ${r.pending ?? '?'} invites pending.${inbound}`,
    };
  });
}

// New connections the robot did not invite (Jibran, 16.11.2026): open each profile at profile pace and
// let the server check the fit against the active campaigns. A fit gets a thank-you message that waits
// for Jibran's approval; anyone else is listed in Leads. Read-only here: nothing is clicked.
async function checkInbound(
  deps: { api: ApiClient },
  run: JobRun,
  tab: RobotTab,
  people: { url: string; name: string }[],
): Promise<string> {
  const counts = { fit: 0, other: 0 };
  for (const [i, p] of people.slice(0, 3).entries()) {
    await run.wait(45_000, 120_000, "before a new connection's profile");
    try {
      await tab.goto(p.url, `New connection ${i + 1}/${people.length}: ${p.name}`);
      await readThrough(run, tab, 2);
      const top = (await tab.send<{ top: ProfileTop | null }>({ type: 'readProfile' })).top;
      await run.wait(8_000, 20_000, 'reading');
      await tab.goto(`${p.url.replace(/\/?$/, '/')}details/experience/`, 'Experience');
      await readThrough(run, tab, 1);
      const experience = (await tab.send<{ items: ExperienceItem[] }>({ type: 'readExperience' }))
        .items;
      const res = (await deps.api.panel('POST', '/ext/inbound/assess', {
        url: p.url,
        profile: {
          name: top?.name ?? p.name,
          headline: top?.headline ?? null,
          location: top?.location ?? null,
          about: top?.about ?? null,
          experience: experience.slice(0, 15).map((e) => ({
            title: e.title,
            company: e.company,
            dates: e.dates,
            location: e.location,
            description: e.description,
          })),
        },
      })) as { status: string };
      if (res.status === 'fit') counts.fit++;
      else counts.other++;
      await run.log(
        res.status === 'fit'
          ? `${p.name}: fits a campaign, thank-you message waits for your approval`
          : `${p.name}: ${res.status === 'existing' ? 'already a prospect' : 'no campaign fit, listed in Leads'}`,
      );
    } catch (err) {
      await deps.api.panel('POST', '/ext/inbound/failed', { url: p.url }).catch(() => undefined);
      await run.log(
        `${p.name}: could not check (${err instanceof Error ? err.message : String(err)})`,
        {
          level: 'warn',
        },
      );
    }
  }
  if (!counts.fit && !counts.other) return '';
  return ` New connections: ${counts.fit} message${counts.fit === 1 ? '' : 's'} to approve, ${counts.other} in Leads.`;
}
