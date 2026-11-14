import type { ApiClient, FeedPost } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { ExperienceItem, ProfileTop } from './adapters/profile.ts';
import type { OwnComment } from './adapters/own-comments.ts';

// Voice profile job (10.10.2026): reads Jibran's OWN profile, Experience, recent posts and comments in
// the robot tab, at reading pace, and sends them to the server, which describes his voice and stores
// a draft for him to approve. Read-only: only "see more" toggles are opened.

interface Deps {
  api: ApiClient;
}

async function readThrough(run: JobRun, tab: RobotTab, steps: number) {
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 8000, 'reading');
  }
  const ex = await tab
    .send<{ opened?: number }>({ type: 'expandSeeMore' })
    .catch(() => ({ opened: 0 }));
  if (ex.opened)
    await run.log(`Opened ${ex.opened} "see more" section${ex.opened === 1 ? '' : 's'}`);
}

export async function runVoiceProfile(
  deps: Deps,
  run: JobRun,
): Promise<{ state: string; message: string }> {
  return withRobotTab(run, 'https://www.linkedin.com/in/me/', async (tab) => {
    await run.log('Reading your profile', { step: 'profile', progress: { pages: 1, maxPages: 4 } });
    await readThrough(run, tab, 3);
    const prof = await tab.send<{ path: string; top: ProfileTop | null }>({ type: 'readProfile' });
    const slug = prof.path.match(/^\/in\/([^/]+)/)?.[1];
    if (!slug || slug === 'me' || !prof.top) throw new Error('Could not open your own profile.');
    const base = `https://www.linkedin.com/in/${slug}`;
    await run.log(`Profile read: ${prof.top.headline ?? ''}`.slice(0, 200));

    await run.wait(20_000, 45_000, 'between pages');
    await tab.goto(`${base}/details/experience/`, 'Opening your Experience');
    await readThrough(run, tab, 2);
    const exp = await tab.send<{ items: ExperienceItem[] }>({ type: 'readExperience' });
    await run.log(`Experience: ${exp.items.length} entr${exp.items.length === 1 ? 'y' : 'ies'}`, {
      progress: { pages: 2 },
    });

    await run.wait(20_000, 45_000, 'between pages');
    await tab.goto(`${base}/recent-activity/all/`, 'Opening your posts');
    await readThrough(run, tab, 8);
    const all = await tab.send<{ posts: FeedPost[] }>({ type: 'readPosts' });
    const me = prof.top.name.toLowerCase().replace(/\s+/g, ' ').trim();
    const own = all.posts.filter((p) => p.author.toLowerCase().replace(/\s+/g, ' ').trim() === me);
    await run.log(`Posts: ${own.length} of your own (of ${all.posts.length} items)`, {
      progress: { pages: 3 },
    });

    await run.wait(20_000, 45_000, 'between pages');
    await tab.goto(`${base}/recent-activity/comments/`, 'Opening your comments');
    await readThrough(run, tab, 8);
    const com = await tab.send<{ comments: OwnComment[] }>({
      type: 'readOwnComments',
      owner: prof.top.name,
    });
    await run.log(`Comments: ${com.comments.length} of yours`, { progress: { pages: 4 } });

    const samples = {
      profile: {
        name: prof.top.name,
        headline: prof.top.headline,
        about: prof.top.about,
        url: `${base}/`,
        location: prof.top.location,
        followers: prof.top.followers,
        connections: prof.top.connections,
        experience: exp.items.slice(0, 20).map((e) => ({
          title: e.title,
          company: e.company,
          dates: e.dates,
          description: e.description,
        })),
      },
      posts: own.slice(0, 40).map((p) => ({ text: p.text, date: p.relativeDate })),
      comments: com.comments.slice(0, 60).map((c) => ({ text: c.text, on: c.on, date: c.date })),
    };
    if (samples.posts.length + samples.comments.length < 3) {
      return {
        state: 'error',
        message: 'Found fewer than 3 of your posts or comments; nothing to learn from yet.',
      };
    }
    await run.log('Describing your voice (AI)…', { step: 'ai' });
    const r = (await deps.api.panel('POST', '/ext/voice/samples', samples)) as {
      id: number;
      droppedQuotes: number;
    };
    return {
      state: 'done',
      message: `Voice profile draft #${r.id} from ${samples.posts.length} posts and ${samples.comments.length} comments. Review it in the Voice tab.`,
    };
  });
}
