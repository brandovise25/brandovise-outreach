import {
  REPLY_HANDLING,
  replyPattern,
  rulesForAction,
  validateDraft,
  wellFormed,
  type ReplyClass,
} from '@outreach/shared';
import type { AppDeps } from './app.ts';
import { callJson } from './db.ts';
import { runTask } from './ai/run.ts';
import { prepareClassifyReplies, prepareDraftReply, type ReplyInput } from './ai/tasks.ts';

// Replies step (Jibran, 13.11.2026). New replies are sorted and, where an answer makes sense, a draft is
// written and put into the Approve tab as "proposed". Nothing here approves or sends: a reply only goes
// out after Jibran's click. Order of decisions for each reply:
//  1. code: legal wording -> for Jibran, no draft; "do not write again" -> the person is blocked;
//  2. model (small): the class;
//  3. model (writing): a draft for interested, question, objection and later. A no gets no answer.
// Safe to call often: a reply is handled once.

interface Pending extends ReplyInput {
  id: number;
  campaign_name: string | null;
  campaign_description: string | null;
}
export interface RepliesResult {
  seen: number;
  blocked: number;
  for_jibran: number;
  drafted: number;
  no_answer: number;
  deferred: number; // left for the next call (AI unavailable or budget used up)
}

const running = new Set<string>();
const audienceOf = (p: Pending) =>
  [p.campaign_name, p.campaign_description?.split(' | ')[0]].filter(Boolean).join(': ') ||
  'AI agents and automation for small businesses';

export async function processReplies(
  deps: AppDeps,
  userId: string,
  max = 10,
): Promise<RepliesResult> {
  const out: RepliesResult = {
    seen: 0,
    blocked: 0,
    for_jibran: 0,
    drafted: 0,
    no_answer: 0,
    deferred: 0,
  };
  if (running.has(userId)) return out;
  running.add(userId);
  try {
    const pending = await callJson<Pending[]>(deps.db, 'ext_reply_pending', [userId, max]);
    out.seen = pending.length;
    if (!pending.length) return out;
    const store = (
      p: Pending,
      outcome: string,
      priority: number,
      reason: string,
      draft: string | null,
      block = false,
    ) =>
      callJson(deps.db, 'ext_reply_classified', [
        userId,
        p.id,
        outcome,
        priority,
        reason,
        draft,
        block,
      ]);

    // 1. Decided in code.
    const forModel: Pending[] = [];
    for (const p of pending) {
      const hit = replyPattern(p.snippet);
      if (hit?.kind === 'escalate') {
        await store(
          p,
          'needs_jibran',
          1,
          `legal or data-protection wording ("${hit.match}")`,
          null,
        );
        out.for_jibran++;
      } else if (hit?.kind === 'opt_out') {
        await store(
          p,
          'opt_out',
          3,
          `asked not to be contacted again ("${hit.match}")`,
          null,
          true,
        );
        out.blocked++;
      } else forModel.push(p);
    }
    if (!forModel.length) return out;

    // 2. The class of each remaining reply, in one call.
    let classes: { index: number; class: ReplyClass; reason: string }[];
    try {
      const task = await prepareClassifyReplies(forModel, { db: deps.db, userId });
      classes = (await runTask<typeof classes>(deps, userId, 'classify_reply', task)).output;
    } catch {
      out.deferred += forModel.length;
      return out;
    }

    // 3. A draft where an answer makes sense. Checked like any other text; a draft that fails a check
    //    is still shown (Jibran edits it), with the reason in front of the class reason.
    const banned = (
      await callJson<{ body: string }>(deps.db, 'ext_get_doc', [userId, 'banned_phrases'])
    ).body
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const [i, p] of forModel.entries()) {
      const c = classes.find((x) => x.index === i);
      if (!c) {
        out.deferred++;
        continue;
      }
      const h = REPLY_HANDLING[c.class];
      if (!h.draft) {
        await store(p, h.outcome, h.priority, c.reason, null);
        out.no_answer++;
        continue;
      }
      let draft: string;
      try {
        const task = await prepareDraftReply(
          { ...p, class: c.class },
          { db: deps.db, userId },
          audienceOf(p),
        );
        draft = wellFormed((await runTask<string>(deps, userId, 'draft_reply', task)).output);
      } catch {
        out.deferred++; // classified again next time, together with the draft
        continue;
      }
      const check = validateDraft(draft, rulesForAction('reply', banned));
      await store(
        p,
        h.outcome,
        h.priority,
        check.ok ? c.reason : `${c.reason} | draft needs a look: ${check.errors.join('; ')}`,
        draft || null,
      );
      out.drafted++;
    }
    return out;
  } finally {
    running.delete(userId);
  }
}

// After a sync round and every few minutes: handle what came in. Not in tests.
export function kickReplies(deps: AppDeps, userId: string): void {
  if (deps.config.NODE_ENV === 'test') return;
  void processReplies(deps, userId).catch(() => undefined);
}
export function startRepliesWorker(deps: AppDeps, everyMs = 15 * 60_000): () => void {
  const tick = async () => {
    const userId = await callJson<string | null>(deps.db, 'ext_api_user', []);
    if (userId) await processReplies(deps, userId);
  };
  const t = setInterval(() => void tick().catch(() => undefined), everyMs);
  t.unref();
  return () => clearInterval(t);
}
