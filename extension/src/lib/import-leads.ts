import type { ApiClient, ProspectPlan, SearchCard } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { withRobotTab, type RobotTab } from './robot-tab.ts';
import type { ExperienceItem, ProfileTop } from './adapters/profile.ts';

// Add people by link (Jibran, 13.11.2026): profile links he found himself. The robot opens each profile
// like a reader (profile + Experience), the server runs the fit check for the chosen campaign, and the
// person lands in Leads for his approval. Nothing is queued or sent from here, and a "no" fit never
// rejects someone he picked: it is shown as the reason.

const MAX_LINKS = 10;

// Only personal profile links (/in/<name>), once each, at most 10, without tracking parameters.
export function cleanProfileUrls(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;]+/);
  const seen = new Set<string>();
  for (const r of raw) {
    const m = String(r).match(/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)/i);
    if (m) seen.add(`https://www.linkedin.com/in/${m[1]!.toLowerCase()}`);
  }
  return [...seen].slice(0, MAX_LINKS);
}

export async function read(run: JobRun, tab: RobotTab, steps: number) {
  for (let s = 0; s < steps; s++) {
    await tab.send({ type: 'gentleScroll' }).catch(() => undefined);
    await run.wait(3000, 8000, 'reading');
  }
}

// Opens one profile like a reader (profile, then Experience) and has the server check it for the
// campaign. The person is only ever put into Leads ("stage only"); null when the profile was unreadable.
export async function researchProfile(
  deps: { api: ApiClient },
  run: JobRun,
  tab: RobotTab,
  url: string,
  o: {
    runId: number;
    keyword: string;
    segment: string;
    campaign: string | null;
    companyId?: number;
  },
): Promise<{ name: string; verdict: string; reason?: string } | null> {
  await read(run, tab, 2 + Math.floor(Math.random() * 2));
  const prof = await tab.send<{ top: ProfileTop | null }>({ type: 'readProfile' });
  const top = prof.top;
  if (!top?.name) return null;
  await run.wait(8_000, 20_000, 'reading');
  await tab.goto(`${url}/details/experience/`, 'Experience');
  await read(run, tab, 1);
  const experience: ExperienceItem[] = (
    await tab.send<{ items: ExperienceItem[] }>({ type: 'readExperience' })
  ).items;
  const degree = top.degreeGuess === '1st' ? ('1st' as const) : null;
  const card: SearchCard = {
    name: top.name,
    profileUrl: url,
    degree,
    headline: top.headline,
    location: top.location,
    snippet: null,
    action: null,
  };
  const r = (await deps.api.panel('POST', '/ext/prospect/assess', {
    runId: o.runId,
    keyword: o.keyword,
    segment: o.segment,
    campaign: o.campaign,
    stageOnly: true,
    mode: 'stage',
    maxApprove: 0,
    score: 100,
    manual: true,
    ...(o.companyId ? { companyId: o.companyId } : {}),
    card,
    profile: {
      name: top.name,
      headline: top.headline,
      location: top.location,
      about: top.about,
      canConnect: top.actions.connect,
      pending: top.actions.pending,
      connected: top.degreeGuess === '1st',
      experience: experience.slice(0, 15).map((e) => ({
        title: e.title,
        company: e.company,
        dates: e.dates,
        location: e.location,
        description: e.description,
      })),
    },
  })) as { verdict: string; reason?: string };
  return { name: top.name, ...r };
}

export async function runImportLeads(
  deps: { api: ApiClient },
  run: JobRun,
  params: { urls?: unknown; campaign?: unknown },
): Promise<{ state: string; message: string }> {
  const urls = cleanProfileUrls(params.urls);
  if (!urls.length)
    return {
      state: 'error',
      message: 'No LinkedIn profile links (https://www.linkedin.com/in/…).',
    };
  const campaign =
    typeof params.campaign === 'string' && /^[a-z0-9-]{1,80}$/.test(params.campaign)
      ? params.campaign
      : null;
  const plan = (await deps.api.panel('POST', '/ext/prospect/plan', {})) as ProspectPlan;
  await run.log(
    `Adding ${urls.length} profile${urls.length === 1 ? '' : 's'} to Leads${campaign ? ` for ${campaign}` : ' (no campaign chosen)'}`,
    { step: 'plan', progress: { profiles: 0, maxProfiles: urls.length } },
  );
  const stats = { staged: 0, duplicate: 0, failed: 0 };
  await withRobotTab(run, urls[0]!, async (tab) => {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;
      if (i > 0) {
        await run.wait(45_000, 120_000, 'between profiles');
        await tab.goto(url, `Profile ${i + 1}/${urls.length}`);
      }
      const r = await researchProfile(deps, run, tab, url, {
        runId: plan.run_id,
        keyword: 'manual link',
        segment: 'import',
        campaign,
      });
      if (!r) {
        stats.failed++;
        await run.log(`${url}: could not read the profile`, { level: 'warn' });
        continue;
      }
      if (r.verdict === 'staged') stats.staged++;
      else if (r.verdict === 'duplicate') stats.duplicate++;
      await run.log(`${r.name}: ${r.verdict}${r.reason ? ` (${r.reason.slice(0, 140)})` : ''}`, {
        progress: { profiles: i + 1, maxProfiles: urls.length },
      });
    }
  });
  const message = `${stats.staged} added to Leads, ${stats.duplicate} already known or pending, ${stats.failed} not readable.`;
  await deps.api.panel('POST', '/ext/prospect/finish', {
    runId: plan.run_id,
    status: 'ok',
    summary: { ...stats, source: 'manual link' },
    notes: message,
  });
  return { state: 'done', message };
}
