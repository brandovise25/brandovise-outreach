import type { ApiClient, FeedPost, KeyValueStore } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import { saveComments } from './round.ts';

// Study round (Jibran, 21.10.2026): reads posts and the comments under them into the comment library,
// to learn how people really comment. Read-only: it opens pages, scrolls, presses "see more" and "Load
// more comments", and never likes, comments or follows. Sources:
//   profiles Jibran names  -> their recent posts that have a discussion
//   default ('feed')       -> random posts with a discussion from the live feed, topped up with posts
//                             the robot saw before
//   'seen'                 -> only posts the robot saw before that the library does not have yet

interface Deps {
  api: ApiClient;
  store: KeyValueStore;
  onWarning: (t: string) => Promise<void>;
}
interface Outcome {
  state: string;
  message: string;
}

const MAX_POSTS = 12;
const PER_PROFILE = 2;

const profileBase = (u: string) => {
  const m = u.match(/^https:\/\/www\.linkedin\.com\/(in|company)\/([^/?#]+)/);
  return m ? `https://www.linkedin.com/${m[1]}/${m[2]}` : null;
};
const postUrl = (p: FeedPost) => `https://www.linkedin.com/feed/update/${p.urn}/`;
const discussed = (p: FeedPost) => !!p.urn && !p.promoted && (p.comments ?? 0) >= 2;

async function seenPosts(deps: Deps, limit: number): Promise<string[]> {
  const r = (await deps.api.panel('POST', '/panel/comment-library/study-plan', {
    limit: Math.min(Math.max(limit, 1), 30),
  })) as { posts: string[] };
  return r.posts;
}

async function readThrough(run: JobRun, tab: RobotTab) {
  const steps = 4 + Math.floor(Math.random() * 4);
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 8000, 'reading');
  }
  await tab.send({ type: 'expandSeeMore' }).catch(() => undefined);
}

export async function runStudyRound(
  deps: Deps,
  run: JobRun,
  params: { profiles?: unknown; posts?: unknown; source?: unknown },
): Promise<Outcome> {
  const profiles = (Array.isArray(params.profiles) ? params.profiles : [])
    .map((p) => profileBase(String(p)))
    .filter((p): p is string => !!p)
    .slice(0, 5);
  const want = Math.min(Math.max(Number(params.posts) || 10, 1), MAX_POSTS);
  const fromFeed = !profiles.length && params.source !== 'seen';
  let posts: string[] = [];
  if (!profiles.length && !fromFeed) {
    posts = await seenPosts(deps, want);
    if (!posts.length)
      return {
        state: 'done',
        message: 'Nothing new to study: every seen post is already in the library.',
      };
  }
  await run.log(
    profiles.length
      ? `Study round: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, up to ${PER_PROFILE} posts each`
      : fromFeed
        ? `Study round: random posts with a discussion from your feed (up to ${want})`
        : `Study round: ${posts.length} posts the robot saw before`,
    { progress: { pages: 0, maxPages: profiles.length + want } },
  );

  const first = profiles.length
    ? `${profiles[0]}/recent-activity/all/`
    : fromFeed
      ? 'https://www.linkedin.com/feed/'
      : posts[0]!;
  let studied = 0;
  let read = 0;
  let moved = false; // whether the tab has left the first page
  await withRobotTab(run, first, async (tab) => {
    // Feed: scroll like a reader (20-30 posts), then pick random posts that have a discussion.
    if (fromFeed) {
      const res = await tab.send<{
        ok: boolean;
        posts?: FeedPost[];
        stoppedBy?: string;
        warning?: string;
      }>({ type: 'scrollFeed', ownWindow: true });
      if (res.stoppedBy === 'warning') {
        await deps.onWarning(res.warning ?? 'LinkedIn warning');
        throw new Error(`${res.warning ?? 'LinkedIn showed a warning'}. Stopped.`);
      }
      const candidates = (res.posts ?? [])
        .filter(discussed)
        .map(postUrl)
        .sort(() => Math.random() - 0.5);
      posts = candidates.slice(0, want);
      await run.log(
        `Feed: ${res.posts?.length ?? 0} posts read, ${candidates.length} with a discussion, studying ${posts.length}`,
      );
      if (posts.length < want) {
        const extra = (await seenPosts(deps, want - posts.length)).filter(
          (u) => !posts.includes(u),
        );
        posts.push(...extra);
        if (extra.length) await run.log(`Adding ${extra.length} posts the robot saw before`);
      }
    }
    // Profiles: their recent posts that have a discussion, newest first.
    for (let i = 0; i < profiles.length; i++) {
      if (i > 0) {
        await run.wait(45_000, 120_000, 'between profiles');
        await tab.goto(
          `${profiles[i]}/recent-activity/all/`,
          `Opening posts of ${profiles[i]!.split('/').pop()}`,
        );
      }
      await readThrough(run, tab);
      const found = (await tab.send<{ posts: FeedPost[] }>({ type: 'readPosts' })).posts ?? [];
      const picked = found.filter(discussed).slice(0, PER_PROFILE).map(postUrl);
      await run.log(
        `${profiles[i]!.split('/').pop()}: ${found.length} posts, ${picked.length} with a discussion`,
      );
      posts.push(...picked.filter((u) => !posts.includes(u)));
    }
    moved = profiles.length > 0 || fromFeed;
    posts = posts.slice(0, MAX_POSTS);
    // Each post: read it through, load the comments, save them.
    for (let i = 0; i < posts.length; i++) {
      if (i > 0 || moved) {
        await run.wait(45_000, 120_000, 'between posts');
        await tab.goto(posts[i]!, `Opening post ${i + 1}/${posts.length}`);
      }
      await readThrough(run, tab);
      const before = read;
      read += await saveComments(deps, run, tab, posts[i]!);
      if (read > before) studied++;
      await run.log(`Post ${i + 1}/${posts.length} done`, {
        progress: { pages: profiles.length + i + 1 },
      });
    }
  });
  return {
    state: 'done',
    message: `Studied ${studied} of ${posts.length} posts: ${read} comments in the library.`,
  };
}
