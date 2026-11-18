import { rulesForAction, validateDraft } from '@outreach/shared';
import type { AppDeps } from './app.ts';
import { callJson } from './db.ts';
import { runTask } from './ai/run.ts';
import { prepareDraftFollowUp, prepareFollowUpDates, type FollowUpInput } from './ai/tasks.ts';

// Follow-ups on replies (Jibran, 18.11.2026). Two steps, both only prepare:
//  1. "Later" replies: the AI reads the date they named ("ab Mitte November" -> 15 Nov).
//  2. Hot replies (interested, question, objection) and "later" ones whose date has come: the AI drafts
//     a follow-up, saved as a reply draft that waits in Approve. Nothing is approved or sent here.
// At most a few drafts per call, inside the daily AI budget; safe to call often.

interface Candidate extends FollowUpInput {
  id: number;
  campaign_name: string | null;
  campaign_description: string | null;
}
export interface FollowUpsResult {
  dated: number;
  drafted: number;
  failed: number;
}

const running = new Set<string>();

export async function processFollowUps(
  deps: AppDeps,
  userId: string,
  opts: { maxDates?: number; maxDrafts?: number; onlyId?: number } = {},
): Promise<FollowUpsResult> {
  const out: FollowUpsResult = { dated: 0, drafted: 0, failed: 0 };
  if (running.has(userId)) return out;
  running.add(userId);
  try {
    // 1. dates
    const pending = await callJson<{ id: number; replied_at: string | null; snippet: string }[]>(
      deps.db,
      'ext_reply_dates_pending',
      [userId, opts.maxDates ?? 20],
    );
    if (pending.length) {
      try {
        const task = await prepareFollowUpDates(pending, { db: deps.db, userId });
        const dates = (
          await runTask<{ index: number; on: string }[]>(deps, userId, 'reply_follow_up_date', task)
        ).output;
        const rows = pending.map((p, i) => ({
          id: p.id,
          on: dates.find((d) => d.index === i)?.on || null,
        }));
        await callJson(deps.db, 'ext_reply_dates_store', [userId, JSON.stringify(rows)]);
        out.dated = rows.length;
      } catch {
        // AI unavailable or budget used up: the next call tries again
      }
    }

    // 2. drafts
    const all = await callJson<Candidate[]>(deps.db, 'ext_reply_follow_up_candidates', [
      userId,
      opts.onlyId ? 20 : (opts.maxDrafts ?? 5),
    ]);
    const candidates = opts.onlyId ? all.filter((c) => c.id === opts.onlyId) : all;
    if (!candidates.length) return out;
    const banned = (
      await callJson<{ body: string }>(deps.db, 'ext_get_doc', [userId, 'banned_phrases'])
    ).body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const c of candidates) {
      try {
        const audience =
          [c.campaign_name, c.campaign_description?.split(' | ')[0]].filter(Boolean).join(': ') ||
          'AI agents and automation for small businesses';
        const task = await prepareDraftFollowUp(c, { db: deps.db, userId }, audience);
        const text = (await runTask<string>(deps, userId, 'draft_follow_up', task)).output;
        // Checked like any reply; a draft that fails a check is still saved (Jibran edits it before
        // approving, and the approval runs the same check).
        const errors = validateDraft(text, rulesForAction('reply', banned)).errors;
        await callJson(deps.db, 'ext_reply_review', [userId, c.id, 'save', null, text]);
        if (errors.length) out.failed++;
        out.drafted++;
      } catch {
        out.failed++;
      }
    }
    return out;
  } finally {
    running.delete(userId);
  }
}
