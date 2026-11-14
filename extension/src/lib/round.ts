import type { ApiClient, KeyValueStore } from '@outreach/shared';
import { currentRun, StopRequested, type JobRun } from './job-run.ts';
import { currentRobotTab, LinkedInBlocked, withRobotTab, type RobotTab } from './robot-tab.ts';

// The comment round: opens the robot's own LinkedIn tab, scrolls the feed at the conduct pace (content
// script), drafts comment ideas on the server, closes the tab and notifies. Every step goes to the job log.
// One round at a time; never outside 07:00-21:00 Berlin or while the robot is paused.

export const ROUND_STATUS_KEY = 'round.status';
export const ROUND_SCHEDULE_KEY = 'round.schedule';
export const ROUND_TIMES = ['11:20', '16:40']; // apart from the Claude Engagement Round (09:51, 15:51)

export interface RoundStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped';
  trigger?: 'manual' | 'auto';
  startedAt?: string;
  finishedAt?: string;
  posts?: number;
  steps?: number;
  drafted?: number;
  skipped?: number;
  costUsd?: number;
  message?: string;
}

interface Deps {
  api: ApiClient;
  store: KeyValueStore;
  onWarning: (text: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function berlinNow(): { hhmm: string; hour: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    hhmm: `${get('hour')}:${get('minute')}`,
    hour: Number(get('hour')),
    day: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

export async function roundStatus(store: KeyValueStore): Promise<RoundStatus> {
  return (await store.get<RoundStatus>(ROUND_STATUS_KEY)) ?? { state: 'idle' };
}

// Feed scrolling reports each step; the robot log gets a line whenever more posts were read.
let lastPosts = -1;
export async function onScrollProgress(posts: number, steps: number) {
  const run = currentRun();
  if (!run || run.kind !== 'comment_round') return;
  if (run.stopped) {
    await currentRobotTab()
      ?.send({ type: 'stopScroll' })
      .catch(() => undefined);
  }
  if (posts === lastPosts) return;
  lastPosts = posts;
  await run.log(`Scrolling the feed: ${posts} posts read (step ${steps})`, {
    step: 'scroll',
    progress: { posts, steps },
  });
}

export async function runCommentRound(
  deps: Deps,
  run: JobRun,
  trigger: 'manual' | 'auto',
): Promise<RoundStatus> {
  const { api, store } = deps;
  const startedAt = new Date().toISOString();
  const end = async (
    state: RoundStatus['state'],
    message: string,
    extra: Partial<RoundStatus> = {},
  ) => {
    const s: RoundStatus = {
      state,
      trigger,
      startedAt,
      finishedAt: new Date().toISOString(),
      message,
      ...extra,
    };
    await store.set(ROUND_STATUS_KEY, s);
    return s;
  };

  const settings = await api.settings();
  if (settings.paused) return end('error', 'The robot is paused (settings.paused).');
  const { hour } = berlinNow();
  if (hour < 7 || hour >= 21)
    return end('error', 'Comment rounds only run between 07:00 and 21:00.');
  await store.set(ROUND_STATUS_KEY, { state: 'running', trigger, startedAt, posts: 0, steps: 0 });
  lastPosts = -1;

  try {
    const res = await withRobotTab(run, 'https://www.linkedin.com/feed/', async (tab) => {
      await run.log('Reading the feed like a reader (20-30 posts, max 8 minutes)', {
        step: 'scroll',
      });
      return tab.send<{
        ok: boolean;
        posts?: unknown[];
        steps?: number;
        stoppedBy?: string;
        seen?: number;
        promoted?: number;
        container?: string;
        nudges?: number;
        warning?: string;
        error?: string;
      }>({ type: 'scrollFeed', ownWindow: true });
    });
    if (!res.ok) return end('error', res.error ?? 'Scrolling failed.');
    if (res.stoppedBy === 'warning') {
      await deps.onWarning(res.warning ?? 'LinkedIn warning');
      return end('error', `${res.warning ?? 'LinkedIn showed a warning'}. Stopped.`);
    }
    if (res.stoppedBy === 'stop') return end('stopped', run.stopReason);
    const posts = res.posts ?? [];
    const why: Record<string, string> = {
      target: 'enough posts',
      time: 'time limit',
      end: 'the feed stopped loading more',
      user: 'page touched',
    };
    await run.log(
      `Feed read: ${posts.length} posts after ${res.steps ?? 0} steps (${res.seen ?? posts.length} cards seen, ${res.promoted ?? 0} ads skipped; scrolled: ${res.container ?? '?'}, ${res.nudges ?? 0}x to the last post; stopped: ${why[res.stoppedBy ?? ''] ?? res.stoppedBy})`,
      { step: 'scroll' },
    );
    if (!posts.length) return end('error', 'No posts found in the feed.');

    await run.log(`Checking ${posts.length} posts for comment ideas (AI)…`, { step: 'draft' });
    const scan = (await api.panel('POST', '/panel/engagement/scan', { posts })) as {
      drafted: number;
      skipped: number;
      alreadyKnown: number;
      costUsd: number;
    };
    const done = await end(
      'done',
      `Read ${posts.length} posts: ${scan.drafted} new idea${scan.drafted === 1 ? '' : 's'}, ${scan.skipped} skipped, ${scan.alreadyKnown} already known.`,
      {
        posts: posts.length,
        steps: res.steps,
        drafted: scan.drafted,
        skipped: scan.skipped,
        costUsd: scan.costUsd,
      },
    );
    if (scan.drafted > 0) {
      await browser.notifications.create(`round-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: 'Brandovise Outreach',
        message: `${scan.drafted} new comment idea${scan.drafted === 1 ? '' : 's'} in the side panel.`,
      });
    }
    return done;
  } catch (err) {
    if (err instanceof StopRequested) return end('stopped', err.message);
    if (err instanceof LinkedInBlocked) {
      await deps.onWarning(err.message);
      return end('error', `${err.message}. Stopped.`);
    }
    return end('error', err instanceof Error ? err.message : String(err));
  }
}

// Automatic sync (Settings → "Sync automatically"): every 25-40 minutes, at random, in robot hours.
// The job waits in the server queue like any other job; a local "next time" keeps one per interval.
export async function maybeAutoSync(deps: Deps): Promise<void> {
  const settings = await deps.api.settings().catch(() => null);
  if (!settings?.sync_auto || settings.paused) return;
  const { hour } = berlinNow();
  if (hour < 7 || hour >= 21) return;
  const next = (await deps.store.get<string>('sync.next')) ?? '';
  if (next && Date.parse(next) > Date.now()) return;
  const minutes = 25 + Math.random() * 15;
  await deps.store.set('sync.next', new Date(Date.now() + minutes * 60_000).toISOString());
  await deps.api.panel('POST', '/ext/jobs', { kind: 'sync_round', params: { trigger: 'auto' } });
}

// Called every few minutes: starts the automatic round when a scheduled time has come (missed times
// are skipped, not stacked).
export async function maybeRunScheduled(deps: Deps): Promise<void> {
  const enabled = (await deps.store.get<boolean>(ROUND_SCHEDULE_KEY)) === true;
  if (!enabled) return;
  const { hhmm, day } = berlinNow();
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const now = toMin(hhmm);
  // The times are set in the app's Settings tab (comment_round_times); the constant is the fallback.
  const times = (await deps.api.settings().catch(() => null))?.comment_round_times ?? ROUND_TIMES;
  const due = times.find((t) => now >= toMin(t) && now < toMin(t) + 10);
  if (!due) return;
  const doneKey = `round.done.${day}.${due}`;
  if (await deps.store.get<boolean>(doneKey)) return;
  await deps.store.set(doneKey, true);
  // Through the job queue, so it shows in the robot bar and log like every other job.
  await deps.api.panel('POST', '/ext/jobs', { kind: 'comment_round', params: { trigger: 'auto' } });
}

// Development helper: opens the pages the sync round will read (inbox, recent connections, sent
// invitations) one after another in the robot tab, at the conduct pace, and saves each raw
// page to the local server (fixtures/raw). Reads only; nothing is clicked.
export const SYNC_PAGES = [
  'https://www.linkedin.com/messaging/',
  'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  'https://www.linkedin.com/mynetwork/invitation-manager/sent/',
];

// On a post page: press "Load more comments" at most twice, then put every comment into the comment
// library (Jibran, 21.10.2026). A failure here never stops the capture.
export async function saveComments(
  deps: Pick<Deps, 'api'>,
  run: JobRun,
  tab: RobotTab,
  url: string,
): Promise<number> {
  try {
    for (let k = 0; k < 2; k++) {
      const more = await tab.send<{ clicked?: boolean }>({ type: 'loadMoreComments' });
      if (!more.clicked) break;
      await run.wait(3000, 7000, 'loading comments');
    }
    const r = await tab.send<{
      post: { author: string; excerpt: string } | null;
      comments: unknown[];
    }>({ type: 'readPostComments' });
    if (!r.comments?.length) {
      await run.log('No comments under this post');
      return 0;
    }
    const saved = (await deps.api.panel('POST', '/panel/comment-library', {
      post: { url, author: r.post?.author ?? null, excerpt: r.post?.excerpt ?? null },
      comments: r.comments,
      source: 'robot',
    })) as { read: number; added: number };
    await run.log(`Comment library: ${saved.read} comments read, ${saved.added} new`);
    return saved.read;
  } catch (err) {
    await run.log(
      `Comment library: not saved (${err instanceof Error ? err.message : String(err)})`,
      {
        level: 'warn',
      },
    );
    return 0;
  }
}

export async function captureSyncPages(
  deps: Deps,
  run: JobRun,
  urls?: string[],
  deep = false,
): Promise<string[]> {
  const saved: string[] = [];
  // Specific pages (developer use) may be given; only LinkedIn, at most 10.
  const custom = (urls ?? []).filter((u) => /^https:\/\/www\.linkedin\.com\//.test(u)).slice(0, 10);
  const pages = custom.length ? custom : [...SYNC_PAGES].sort(() => Math.random() - 0.5);
  await run.log(
    `Saving ${pages.length} page${pages.length === 1 ? '' : 's'} for development${deep ? ', reading each one through' : ''}`,
    { progress: { pages: 0, maxPages: pages.length } },
  );
  await withRobotTab(run, pages[0]!, async (tab) => {
    for (let i = 0; i < pages.length; i++) {
      if (i > 0) {
        // Profile pace for read-through visits, page pace otherwise.
        if (deep) await run.wait(45_000, 120_000, 'between profile pages');
        else await run.wait(20_000, 45_000, 'between pages');
        await tab.goto(
          pages[i]!,
          `Opening ${new URL(pages[i]!).pathname} (${i + 1}/${pages.length})`,
        );
      }
      if (deep) {
        // Read the page top to bottom in irregular steps, open "…see more", then save.
        const steps = 5 + Math.floor(Math.random() * 6);
        await run.log(`Reading the page (${steps} scroll steps)`, { step: 'read' });
        for (let s = 0; s < steps; s++) {
          await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
          await run.wait(3000, 9000, 'reading');
        }
        const ex = await tab
          .send<{ opened?: number }>({ type: 'expandSeeMore' })
          .catch(() => ({ opened: 0 }));
        if (ex.opened)
          await run.log(`Opened ${ex.opened} "see more" section${ex.opened === 1 ? '' : 's'}`);
        if (/\/feed\/update\//.test(pages[i]!)) await saveComments(deps, run, tab, pages[i]!);
      } else {
        // Two reading-pace scroll steps so lazy parts render, then capture.
        for (let s = 0; s < 2; s++) {
          await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
          await sleep(2000 + Math.random() * 3000);
        }
      }
      const page = await tab.send<{
        ok: boolean;
        kind?: string;
        lang?: string;
        html?: string;
        error?: string;
      }>({
        type: 'capture',
        raw: true,
      });
      if (!page.ok) throw new Error(page.error ?? 'capture failed');
      const r = (await deps.api.panel('POST', '/panel/dev/capture', {
        kind: page.kind,
        lang: page.lang,
        html: page.html,
        redacted: false,
      })) as { file: string };
      saved.push(r.file);
      await run.log(
        `Saved ${r.file.split('/').pop()} (${Math.round((page.html?.length ?? 0) / 1024)} KB)`,
        {
          progress: { pages: i + 1 },
        },
      );
    }
  });
  return saved;
}
