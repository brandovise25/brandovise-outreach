import type { FeedPost } from '@outreach/shared';
import { readPosts } from './posts.ts';
import { linkedInWarning } from './detectors.ts';
import { scroller, scrollState, scrollStep } from './scroller.ts';

// Scrolls the feed like an unhurried reader (browsing_conduct "Scrolling"): steps of 3-5 ticks, 2-5 s
// between steps, now and then a small step back up, a longer pause every few steps. Collects the posts
// that came into view. Stops on: enough posts, time cap, Stop, the user touching the page, or any
// LinkedIn warning. It only scrolls and, when the feed stops loading, presses LinkedIn's own
// "Show more" button; it never opens, likes or comments on anything.

export interface ScrollOptions {
  targetPosts: number;
  maxMs: number;
  signal: { stopped: boolean; reason?: string };
  // Called after every step (the round uses it to keep the service worker alive and show progress).
  onProgress?: (posts: number, steps: number) => void;
  stopOnUserInput?: boolean;
}

export interface ScrollResult {
  posts: FeedPost[];
  steps: number;
  stoppedBy: 'target' | 'time' | 'stop' | 'user' | 'warning' | 'end';
  warning?: string;
  seen?: number;
  promoted?: number;
  container?: string;
  nudges?: number; // times the last post was brought into view because scrolling loaded nothing
}

const TICK_PX = 100;
const SHOW_MORE =
  /^(show more feed updates|show more results|load more|mehr anzeigen|weitere beiträge anzeigen|mehr laden)$/i;
const CARD = '[componentkey^="update-card-focus"], [data-urn^="urn:li:activity:"]';
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scrollFeed(opts: ScrollOptions): Promise<ScrollResult> {
  const started = Date.now();
  const collected = new Map<string, FeedPost>();
  const collect = () => {
    for (const p of readPosts(document))
      collected.set(`${p.urn ?? p.author}|${p.text.slice(0, 80)}`, p);
  };

  // Any real input from Jibran ends the run: he is using the page himself.
  const userTouched = () => {
    opts.signal.stopped = true;
    opts.signal.reason = 'user';
  };
  const events =
    opts.stopOnUserInput === false
      ? []
      : (['wheel', 'keydown', 'mousedown', 'touchstart'] as const);
  events.forEach((e) => window.addEventListener(e, userTouched, { capture: true, passive: true }));

  let steps = 0;
  let lastHeight = 0;
  let stalls = 0;
  let idle = 0; // forward steps in a row without a new post
  let nudges = 0;
  let stoppedBy: ScrollResult['stoppedBy'] = 'time';
  let warning: string | undefined;
  try {
    collect();
    while (Date.now() - started < opts.maxMs) {
      warning = linkedInWarning(document, location.pathname) ?? undefined;
      if (warning) {
        stoppedBy = 'warning';
        break;
      }
      if (opts.signal.stopped) {
        stoppedBy = opts.signal.reason === 'user' ? 'user' : 'stop';
        break;
      }
      // Ads do not count towards the target (10.10.2026: rounds stopped after one step with 8 posts).
      const real = [...collected.values()].filter((p) => !p.promoted).length;
      if (real >= opts.targetPosts) {
        stoppedBy = 'target';
        break;
      }

      steps++;
      const backtrack = steps % Math.round(rand(3, 5)) === 0;
      const ticks = backtrack ? -Math.round(rand(1, 2)) : Math.round(rand(3, 5));
      scrollStep(ticks * TICK_PX * rand(0.9, 1.15));
      await sleep(rand(2000, 5000));
      // A longer reading pause now and then.
      if (steps % Math.round(rand(4, 6)) === 0) await sleep(rand(6000, 12000));
      const before = collected.size;
      collect();
      opts.onProgress?.(collected.size, steps);

      // Scrolling the guessed box loaded nothing (17./19.10.2026: 8 posts after 43 steps): bring the
      // last post into view instead, whichever element really scrolls; that is what loads the next ones.
      idle = collected.size > before ? 0 : backtrack ? idle : idle + 1;
      if (idle >= 3) {
        const cards = document.querySelectorAll(CARD);
        cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        nudges++;
        idle = 0;
        await sleep(rand(2500, 4500));
        collect();
      }

      // LinkedIn's newer feed does not load on scroll: it ends with its own "Load more" button. Press it
      // once it is in view, like a reader at the end of the list (11.10.2026: rounds saw only 7-8 posts).
      const loadMore = Array.from(
        document.querySelectorAll('main button, [data-testid="mainFeed"] button'),
      ).find(
        (b) => SHOW_MORE.test((b.textContent ?? '').trim()) && !(b as HTMLButtonElement).disabled,
      ) as HTMLButtonElement | undefined;
      if (loadMore) {
        const r = loadMore.getBoundingClientRect();
        if (r.top < window.innerHeight + 400) {
          loadMore.click();
          await sleep(rand(3000, 6000));
          collect();
          continue;
        }
      }

      // Feed stopped growing: press LinkedIn's own "Show more" once, else give up.
      const pos = scrollState();
      const h = pos.height;
      const nearBottom = pos.top + pos.view > h - 300;
      stalls = h === lastHeight && nearBottom ? stalls + 1 : 0;
      lastHeight = h;
      if (stalls >= 2) {
        const more = Array.from(document.querySelectorAll('main button')).find((b) =>
          SHOW_MORE.test((b.textContent ?? '').trim()),
        ) as HTMLButtonElement | undefined;
        if (!more) {
          stoppedBy = 'end';
          break;
        }
        more.click();
        stalls = 0;
        await sleep(rand(3000, 6000));
      }
    }
  } finally {
    events.forEach((e) => window.removeEventListener(e, userTouched, { capture: true }));
  }
  const all = [...collected.values()];
  return {
    posts: all.filter((p) => !p.promoted).slice(0, 30),
    steps,
    stoppedBy,
    warning,
    seen: all.length,
    container: (() => {
      const el = scroller();
      return el === document.scrollingElement || el === document.documentElement
        ? 'page'
        : `${el.tagName.toLowerCase()} (inner box)`;
    })(),
    promoted: all.filter((p) => p.promoted).length,
    nudges,
  };
}
