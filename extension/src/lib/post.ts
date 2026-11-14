import type { ApiClient, CommentAttempt, CommentTarget, KeyValueStore } from '@outreach/shared';
import { StopRequested, type JobRun } from './job-run.ts';
import { berlinNow } from './round.ts';
import { LinkedInBlocked, withRobotTab } from './robot-tab.ts';

// Posts one approved comment on Jibran's click: fact check on the server, the robot tab on the post
// (or the author's recent activity when no link is known), the content script types and (live mode)
// posts, the result is recorded, the tab closes. Every step goes to the job log.

export const POST_STATUS_KEY = 'post.status';
export interface PostStatus {
  id?: number;
  state: 'idle' | 'running' | 'done' | 'error';
  message?: string;
  at?: string;
}

export async function postStatus(store: KeyValueStore): Promise<PostStatus> {
  return (await store.get<PostStatus>(POST_STATUS_KEY)) ?? { state: 'idle' };
}

export async function postComment(
  deps: { api: ApiClient; store: KeyValueStore; onWarning: (t: string) => Promise<void> },
  run: JobRun,
  id: number,
): Promise<PostStatus> {
  const { api, store } = deps;
  const finish = async (state: PostStatus['state'], message: string) => {
    const s: PostStatus = { id, state, message, at: new Date().toISOString() };
    await store.set(POST_STATUS_KEY, s);
    return s;
  };
  await store.set(POST_STATUS_KEY, {
    id,
    state: 'running',
    message: 'Fact-checking…',
    at: new Date().toISOString(),
  });

  await run.log(`Comment #${id}: fact check`, { step: 'factcheck' });
  let target: CommentTarget;
  try {
    target = (await api.panel('POST', `/panel/comments/${id}/prepare`)) as CommentTarget;
  } catch (err) {
    return finish('error', `Not posted. ${err instanceof Error ? err.message : String(err)}`);
  }
  const settings = await api.settings();
  if (settings.paused) return finish('error', 'The robot is paused.');
  const { hour } = berlinNow();
  if (hour < 7 || hour >= 21) return finish('error', 'Posting only runs between 07:00 and 21:00.');

  // Without a post link, find the post among the author's own posts: a person's recent activity or a
  // company's posts page.
  const profile = target.author_profile?.replace(/\/?$/, '/') ?? null;
  const url =
    target.post_url ||
    (profile
      ? /\/company\//.test(profile)
        ? `${profile}posts/?feedView=all`
        : `${profile}recent-activity/all/`
      : null);
  if (!url) return finish('error', 'No link to the post and no author profile to find it from.');
  await run.log(
    target.post_url
      ? `Fact check passed. ${target.live ? 'Posting' : 'Practice run'} on the post`
      : `Fact check passed. No post link: looking for the post on the author's page`,
    { step: 'open' },
  );

  try {
    const attempt = await withRobotTab(run, url, async (tab) => {
      // Long, irregular pauses: read the post (20-60 s), type, look it over (8-25 s), then post.
      const readMs = Math.round(20_000 + Math.random() * 40_000);
      const reviewMs = Math.round(8_000 + Math.random() * 17_000);
      await run.log(
        `Reading the post (~${Math.round(readMs / 1000)} s), typing, looking it over (~${Math.round(reviewMs / 1000)} s)${target.live ? ', then posting' : ' (practice: not posted)'}`,
        { step: 'type', progress: { waitUntil: new Date(Date.now() + readMs).toISOString() } },
      );
      return tab.send<CommentAttempt>({
        type: 'commentOnPost',
        text: target.text,
        excerpt: target.post_excerpt ?? '',
        dryRun: !target.live,
        readMs,
        reviewMs,
      });
    });
    await api.panel('POST', `/panel/comments/${id}/result`, attempt);
    if (attempt.note.startsWith('Stopped:')) await deps.onWarning(attempt.note);
    const ok = attempt.verified || (attempt.dryRun && attempt.button);
    // The job's finish line in the log carries attempt.note.
    return finish(ok ? 'done' : 'error', attempt.note);
  } catch (err) {
    if (err instanceof StopRequested) return finish('error', err.message);
    if (err instanceof LinkedInBlocked) {
      await deps.onWarning(err.message);
      return finish('error', `${err.message}. Stopped.`);
    }
    return finish('error', err instanceof Error ? err.message : String(err));
  }
}
