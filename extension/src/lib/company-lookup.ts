import { ownerMatch, type ApiClient, type ProspectPlan } from '@outreach/shared';
import type { JobRun } from './job-run.ts';
import { read, researchProfile } from './import-leads.ts';
import { searchUrl } from './prospect.ts';
import { withRobotTab } from './robot-tab.ts';
import type { SearchPerson } from './adapters/search.ts';

// Company first (Jibran, 13.11.2026): a company's website named its owner in the Impressum. The robot
// searches that person on LinkedIn ("name company"), and only when exactly one result carries the name
// and the company, opens the profile like a reader and hands it to the fit check. The person lands in
// Leads with the company's signals; nothing is queued or sent from here. A few companies per run, at the
// pace of a prospect round.

interface LookupPlan {
  waiting: number;
  without_campaign: number;
  items: {
    id: number;
    domain: string;
    name: string | null;
    campaign_id: string;
    segment: string | null;
    owner: string | null;
  }[];
}

export async function runCompanyLookup(
  deps: { api: ApiClient },
  run: JobRun,
  params: { max?: unknown },
): Promise<{ state: string; message: string }> {
  const max = Math.min(8, Math.max(1, Number(params.max) || 5));
  const lookup = (await deps.api.panel('POST', '/panel/companies/lookup-plan', {
    max,
  })) as LookupPlan;
  const items = lookup.items.filter((c) => c.owner);
  if (!items.length)
    return {
      state: 'done',
      message: lookup.without_campaign
        ? `${lookup.without_campaign} companies have no campaign yet. Choose one in Leads → Companies.`
        : 'No company with a known owner is waiting.',
    };
  const plan = (await deps.api.panel('POST', '/ext/prospect/plan', {})) as ProspectPlan;
  const label = (c: LookupPlan['items'][number]) => c.name ?? c.domain.split('.')[0]!;
  const query = (c: LookupPlan['items'][number]) => `${c.owner} ${label(c)}`;
  await run.log(`Looking up the owners of ${items.length} companies`, {
    step: 'plan',
    progress: { profiles: 0, maxProfiles: items.length },
  });
  const stats = { staged: 0, duplicate: 0, notFound: 0 };
  const done = (id: number, status: 'found' | 'not_found' | 'duplicate') =>
    deps.api.panel('POST', `/panel/companies/${id}/lookup`, { status });

  await withRobotTab(run, searchUrl(query(items[0]!), 1), async (tab) => {
    for (let i = 0; i < items.length; i++) {
      const c = items[i]!;
      if (i > 0) {
        await run.wait(45_000, 120_000, 'between companies');
        await tab.goto(searchUrl(query(c), 1), `Search "${query(c)}"`);
      } else await run.log(`Search "${query(c)}"`);
      await read(run, tab, 2);
      const res = await tab.send<{ people: SearchPerson[] }>({ type: 'readSearch' });
      const hit = ownerMatch(res.people, c.owner!, { name: c.name, domain: c.domain });
      const person = hit >= 0 ? res.people[hit] : undefined;
      if (!person) {
        stats.notFound++;
        await done(c.id, 'not_found');
        await run.log(`${c.domain}: ${c.owner} not clearly found (${res.people.length} results)`, {
          progress: { profiles: i + 1, maxProfiles: items.length },
        });
        continue;
      }
      await run.wait(8_000, 20_000, 'reading');
      const url = person.profileUrl.replace(/\/$/, '');
      await tab.goto(url, person.name);
      const r = await researchProfile(deps, run, tab, url, {
        runId: plan.run_id,
        keyword: 'company lookup',
        segment: c.segment ?? 'company',
        campaign: c.campaign_id,
        companyId: c.id,
      });
      if (!r) {
        stats.notFound++;
        await done(c.id, 'not_found');
        await run.log(`${c.domain}: could not read the profile of ${person.name}`, {
          level: 'warn',
        });
        continue;
      }
      if (r.verdict === 'staged') stats.staged++;
      else stats.duplicate++;
      await done(c.id, r.verdict === 'staged' ? 'found' : 'duplicate');
      await run.log(
        `${c.domain}: ${r.name}: ${r.verdict}${r.reason ? ` (${r.reason.slice(0, 140)})` : ''}`,
        {
          progress: { profiles: i + 1, maxProfiles: items.length },
        },
      );
    }
  });
  const message = `${stats.staged} owners added to Leads, ${stats.duplicate} already known, ${stats.notFound} not clearly found.`;
  await deps.api.panel('POST', '/ext/prospect/finish', {
    runId: plan.run_id,
    status: 'ok',
    summary: { ...stats, source: 'company lookup' },
    notes: message,
  });
  return { state: 'done', message };
}
