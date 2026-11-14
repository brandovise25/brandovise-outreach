import type { AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { resolveLeadCompanies } from './discover.ts';
import { profileCompany, type CompanyProfile } from './profile-company.ts';

// Reads the websites of companies that were added (pasted, found by search, or seen on a lead) and stores
// the signals. One company after the other, a few per run; started when companies are added and every
// few minutes. Failures are recorded on the company and never stop the queue.

type Profiler = (domain: string) => Promise<CompanyProfile>;
let running = false;

export async function runCompanyQueue(
  deps: AppDeps,
  max = 5,
  profiler: Profiler = profileCompany,
): Promise<number> {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    const userId = await callJson<string | null>(deps.db, 'ext_api_user', []);
    if (!userId) return 0;
    // Websites for leads that were found on LinkedIn (needs the web search key; not in tests).
    if (deps.config.NODE_ENV !== 'test')
      await resolveLeadCompanies(deps, userId).catch(() => undefined);
    const next = await callJson<{ id: number; domain: string }[]>(deps.db, 'ext_company_next', [
      userId,
      max,
    ]);
    for (const c of next) {
      const p = await profiler(c.domain).catch((err): CompanyProfile => ({
        domain: c.domain,
        homeUrl: null,
        blocked: false,
        error: String(err),
        pages: [],
        observations: [],
        impressum: null,
      }));
      const status = p.blocked ? 'blocked' : p.error || !p.pages.length ? 'error' : 'ok';
      await callJson(deps.db, 'ext_company_profiled', [
        userId,
        c.id,
        status,
        p.blocked ? 'the site blocked the reader' : p.error,
        null,
        JSON.stringify(p.observations),
      ]);
      done++;
    }
  } finally {
    running = false;
  }
  return done;
}

// Started after companies were added; not in tests, where the reader must not go to the network.
export function kickCompanyQueue(deps: AppDeps): void {
  if (deps.config.NODE_ENV === 'test') return;
  void runCompanyQueue(deps).catch(() => undefined);
}

export function startCompanyWorker(deps: AppDeps, everyMs = 120_000): () => void {
  const tick = () => void runCompanyQueue(deps).catch(() => undefined);
  const t = setInterval(tick, everyMs);
  t.unref();
  return () => clearInterval(t);
}
