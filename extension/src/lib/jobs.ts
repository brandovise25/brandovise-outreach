import type { ApiClient, KeyValueStore } from '@outreach/shared';
import { refreshLoginState } from './linkedin-login.ts';
import { JobRun, StopRequested } from './job-run.ts';
import { captureSyncPages, runCommentRound } from './round.ts';
import { postComment } from './post.ts';
import { runVoiceProfile } from './voice.ts';
import { runSyncRound } from './sync.ts';
import { runSendRound } from './send.ts';
import { runProspectRound } from './prospect.ts';
import { runStudyRound } from './study.ts';
import { runCompanyLookup } from './company-lookup.ts';
import { runImportLeads } from './import-leads.ts';

// All LinkedIn work runs as a job from the server queue (side panel buttons, schedule, remote API,
// auto-post planner), one at a time, in the robot tab. Every step is logged to the server, so the app's
// robot bar and `scripts/outreach.sh log` show what is happening. Called every minute by an alarm and
// right away when the app queues something.

interface Job {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  created_by: string;
}
interface Deps {
  api: ApiClient;
  store: KeyValueStore;
  onWarning: (t: string) => Promise<void>;
}
interface Outcome {
  state?: string;
  message?: string;
}

let busy = false;

export async function runNextJob(deps: Deps): Promise<void> {
  if (busy || !(await deps.api.isSignedIn())) return;
  // LinkedIn logged out: jobs stay queued until Jibran logs in (the icon is grey meanwhile).
  if (!(await refreshLoginState())) return;
  busy = true;
  try {
    // Keep going while there is work (a panel click may have queued several things).
    for (let i = 0; i < 5; i++) {
      const job = ((await deps.api.panel('POST', '/ext/jobs/claim', {})) as { job: Job | null })
        .job;
      if (!job) return;
      await runJob(deps, job);
    }
  } catch {
    // Server unreachable: the next alarm tries again.
  } finally {
    busy = false;
  }
}

async function runJob(deps: Deps, job: Job): Promise<void> {
  const run = new JobRun(deps.api, job.id, job.kind).begin();
  let result: Outcome;
  let warned = false;
  const onWarning = async (t: string) => {
    warned = true;
    await run.log(t, { level: 'error', step: 'warning' });
    await deps.onWarning(t);
  };
  const d = { ...deps, onWarning };
  try {
    await run.log(`Started (${job.created_by})`, { step: 'start' });
    if (job.kind === 'comment_round') {
      const auto = job.created_by !== 'panel' || job.params.trigger === 'auto';
      result = await runCommentRound(d, run, auto ? 'auto' : 'manual');
    } else if (job.kind === 'post_comment') {
      result = await postComment(d, run, Number(job.params.id));
    } else if (job.kind === 'capture_sync') {
      const urls = Array.isArray(job.params.urls)
        ? (job.params.urls as unknown[]).map(String)
        : undefined;
      const files = await captureSyncPages(d, run, urls, job.params.deep === true);
      result = { state: 'done', message: `Saved ${files.length} pages` };
    } else if (job.kind === 'voice_profile') {
      result = await runVoiceProfile(d, run);
    } else if (job.kind === 'sync_round') {
      result = await runSyncRound(d, run);
    } else if (job.kind === 'send_round') {
      result = await runSendRound(d, run, Number(job.params.max) || 5);
    } else if (job.kind === 'prospect_round') {
      result = await runProspectRound(d, run);
    } else if (job.kind === 'import_leads') {
      result = await runImportLeads(d, run, job.params);
    } else if (job.kind === 'company_lookup') {
      result = await runCompanyLookup(d, run, job.params);
    } else if (job.kind === 'study_comments') {
      result = await runStudyRound(d, run, job.params);
    } else {
      result = { state: 'error', message: `This extension version cannot run "${job.kind}" yet.` };
    }
  } catch (err) {
    result =
      err instanceof StopRequested
        ? { state: 'stopped', message: err.message }
        : { state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  const status =
    result.state === 'done' ? 'done' : result.state === 'stopped' ? 'stopped' : 'error';
  await deps.api
    .panel('POST', `/ext/jobs/${job.id}/finish`, {
      status: run.stopped && status !== 'done' ? 'stopped' : status,
      result: { message: result.message ?? '', state: result.state ?? '' },
    })
    .catch(() => undefined);
  run.end(warned);
}
