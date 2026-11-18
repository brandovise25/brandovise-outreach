import type { ApiClient, ProspectPlan, SearchCard } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { SearchPerson } from './adapters/search.ts';
import type { ExperienceItem, ProfileTop } from './adapters/profile.ts';

// Prospect round (ports the "LinkedIn Prospecting Round" routine): 4 keyword sets (one per campaign first) x 2-4 result pages,
// read like a person; the server screens the cards (duplicates, hard skips, AI against the targeting
// rules); at most 12 profiles are opened (a visit shows up in "who viewed your profile"), each with its
// Experience page; the server runs the fit check and adds leads (approved within the queue gate, else
// staged). Max ~36 page loads per round. Never connects or messages.

const MAX_PROFILES = 12;
const MIN_PAGES = 2; // result pages read for every search word
const MAX_PAGES = 4; // a productive word may go deeper (13.11.2026)
const PAGE_LOAD_BUDGET = 36; // search pages + profile and experience pages in one round
// With geo (LinkedIn location ids) the search is limited to those places, as LinkedIn's own filter does.
export const searchUrl = (kw: string, page: number, geo?: string[]) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}${
    geo?.length
      ? `&geoUrn=${encodeURIComponent(JSON.stringify(geo))}&origin=FACETED_SEARCH`
      : '&origin=GLOBAL_SEARCH_HEADER'
  }${page > 1 ? `&page=${page}` : ''}`;

async function read(run: JobRun, tab: RobotTab, steps: number) {
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 8000, 'reading');
  }
}

export async function runProspectRound(
  deps: { api: ApiClient },
  run: JobRun,
): Promise<{ state: string; message: string }> {
  const plan = (await deps.api.panel('POST', '/ext/prospect/plan', {})) as ProspectPlan;
  await run.log(
    plan.mode === 'approve'
      ? `Mode: approve up to ${plan.max_approve} (queue waiting for invites: ${plan.waiting})`
      : `Mode: stage only (${plan.why}). Good fits are kept for your review, nobody is queued.`,
    { step: 'plan' },
  );
  if (!plan.keywords.length) {
    await deps.api.panel('POST', '/ext/prospect/finish', {
      runId: plan.run_id,
      status: 'aborted',
      summary: {},
      notes: 'no keyword sets',
    });
    return {
      state: 'error',
      message: 'No keyword sets (Settings → Prompts & rules → Prospecting keywords).',
    };
  }
  await run.log(`Keywords: ${plan.keywords.map((k) => k.keyword).join(' · ')}`);
  const queue: {
    card: SearchCard;
    score: number;
    reason: string;
    kw: (typeof plan.keywords)[number];
  }[] = [];
  const stats = {
    searched: 0,
    screenedOut: 0,
    opened: 0,
    approved: 0,
    staged: 0,
    rejected: 0,
    duplicate: 0,
  };
  let loads = 0;

  const result = await withRobotTab(
    run,
    searchUrl(plan.keywords[0]!.keyword, 1, plan.keywords[0]!.geo),
    async (tab) => {
      for (let k = 0; k < plan.keywords.length; k++) {
        const kw = plan.keywords[k]!;
        let maxPages = MIN_PAGES;
        for (let page = 1; page <= maxPages; page++) {
          if (k > 0 || page > 1) {
            await run.wait(20_000, 45_000, page > 1 ? 'between result pages' : 'between keywords');
            await tab.goto(
              searchUrl(kw.keyword, page, kw.geo),
              `Search "${kw.keyword}" page ${page}`,
            );
          } else await run.log(`Search "${kw.keyword}" page 1`);
          loads++;
          await read(run, tab, 3);
          const res = await tab.send<{ people: SearchPerson[]; hasNext: boolean }>({
            type: 'readSearch',
          });
          stats.searched += res.people.length;
          const cards: SearchCard[] = res.people.map((p) => ({
            name: p.name,
            profileUrl: p.profileUrl,
            degree: p.degree,
            headline: p.headline,
            location: p.location,
            snippet: p.snippet,
            action: p.action,
          }));
          const s = (await deps.api.panel('POST', '/ext/prospect/screen', {
            runId: plan.run_id,
            keyword: kw.keyword,
            segment: kw.segment,
            campaign: kw.campaign,
            cards,
          })) as { open: { card: SearchCard; score: number; reason: string }[]; recorded: number };
          stats.screenedOut += s.recorded;
          queue.push(...s.open.map((o) => ({ ...o, kw })));
          await run.log(
            `"${kw.keyword}" p${page}: ${cards.length} people, ${s.open.length} worth opening`,
            {
              progress: {
                pageLoads: loads,
                maxPageLoads: PAGE_LOAD_BUDGET,
                candidates: queue.length,
              },
            },
          );
          if (!res.hasNext) break;
          // A word that still gives good people on its last page may go one page deeper, within the budget.
          if (page === maxPages && maxPages < MAX_PAGES && s.open.length >= 2 && loads < 14) {
            maxPages++;
            await run.log(
              `"${kw.keyword}": ${s.open.length} good people on page ${page}, reading page ${maxPages} too`,
            );
          }
        }
      }

      const toOpen = queue.sort((a, b) => b.score - a.score).slice(0, MAX_PROFILES);
      for (let i = 0; i < toOpen.length; i++) {
        const q = toOpen[i]!;
        await run.wait(45_000, 120_000, 'between profiles');
        await tab.goto(q.card.profileUrl, `Profile ${i + 1}/${toOpen.length}: ${q.card.name}`);
        loads++;
        await read(run, tab, 2 + Math.floor(Math.random() * 2));
        const prof = await tab.send<{ top: ProfileTop | null }>({ type: 'readProfile' });
        let experience: ExperienceItem[] = [];
        if (loads < PAGE_LOAD_BUDGET - 2) {
          await run.wait(8_000, 20_000, 'reading');
          await tab.goto(
            `${q.card.profileUrl.replace(/\/?$/, '/')}details/experience/`,
            'Experience',
          );
          loads++;
          await read(run, tab, 1);
          experience = (await tab.send<{ items: ExperienceItem[] }>({ type: 'readExperience' }))
            .items;
        }
        stats.opened++;
        const top = prof.top;
        const r = (await deps.api.panel('POST', '/ext/prospect/assess', {
          runId: plan.run_id,
          keyword: q.kw.keyword,
          segment: q.kw.segment,
          campaign: q.kw.campaign,
          stageOnly: q.kw.stage_only === true,
          mode: plan.mode,
          maxApprove: plan.max_approve,
          score: q.score,
          card: q.card,
          profile: {
            name: top?.name ?? q.card.name,
            headline: top?.headline ?? q.card.headline,
            location: top?.location ?? q.card.location,
            about: top?.about ?? null,
            canConnect: top?.actions.connect ?? false,
            pending: top?.actions.pending ?? false,
            connected: top?.degreeGuess === '1st',
            experience: experience.slice(0, 15).map((e) => ({
              title: e.title,
              company: e.company,
              dates: e.dates,
              location: e.location,
              description: e.description,
            })),
          },
        })) as { verdict: 'approved' | 'staged' | 'rejected' | 'duplicate'; reason?: string };
        stats[r.verdict]++;
        await run.log(
          `${q.card.name}: ${r.verdict}${r.reason ? ` (${r.reason.slice(0, 140)})` : ''}`,
          {
            progress: { profiles: i + 1, maxProfiles: toOpen.length, pageLoads: loads },
          },
        );
      }
      return stats;
    },
  );

  const message = `Searched ${result.searched} people, opened ${result.opened}: ${result.approved} approved, ${result.staged} staged for review, ${result.rejected} not a fit, ${result.duplicate} already known.`;
  await deps.api.panel('POST', '/ext/prospect/finish', {
    runId: plan.run_id,
    status: 'ok',
    summary: { ...result, mode: plan.mode, keywords: plan.keywords.map((k) => k.keyword) },
    notes: message,
  });
  return { state: 'done', message };
}
