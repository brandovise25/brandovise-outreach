import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DEAL_STAGES, rulesForAction, validateDraft } from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { processFollowUps } from '../follow-ups.ts';
import { processReplies } from '../replies.ts';

// Replies inbox and deal stages (plan 13.11.2026). Drafts are approved here or in the Approve tab; the
// send round then sends them. Nothing is approved without Jibran's click.

export const ReplyReview = z.object({
  action: z.enum(['approve', 'save', 'dismiss', 'answered', 'outcome']),
  outcome: z
    .enum([
      'interested',
      'question',
      'objection',
      'not_now',
      'not_interested',
      'wrong_target',
      'out_of_office',
      'other',
    ])
    .nullable()
    .default(null),
  text: z.string().max(8000).nullable().default(null),
});

export async function replyApprovalErrors(
  deps: AppDeps,
  userId: string,
  text: string,
): Promise<string[]> {
  const banned = (
    await callJson<{ body: string }>(deps.db, 'ext_get_doc', [userId, 'banned_phrases'])
  ).body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return validateDraft(text, rulesForAction('reply', banned)).errors;
}

export const replyRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });

  app.get('/replies', async (req) => {
    const { filter } = z
      .object({ filter: z.enum(['open', 'all', 'deals']).default('open') })
      .parse(req.query);
    return callJson(deps.db, 'ext_reply_inbox', [req.auth!.userId, filter]);
  });

  // Sort new replies and draft answers now (also runs after every sync and every 15 minutes).
  app.post(
    '/replies/process',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req) => {
      const { max } = z
        .object({ max: z.number().int().min(1).max(25).default(10) })
        .parse(req.body ?? {});
      return processReplies(deps, req.auth!.userId, max);
    },
  );

  // Everyone who wrote back, in sections: hot, due, later, answered, closed (Leads -> Replied).
  app.get('/replies/board', async (req) =>
    callJson(deps.db, 'ext_reply_board', [req.auth!.userId]),
  );
  // Read follow-up dates and draft follow-ups now (also runs every 15 minutes). id: only this person.
  app.post(
    '/replies/follow-ups',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z
        .object({
          max: z.number().int().min(1).max(20).default(5),
          id: z.number().int().positive().optional(),
        })
        .parse(req.body ?? {});
      return processFollowUps(deps, req.auth!.userId, { maxDrafts: b.max, onlyId: b.id });
    },
  );
  app.post('/replies/:id/follow-up-on', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { on } = z.object({ on: z.iso.date().nullable() }).parse(req.body);
    return callJson(deps.db, 'ext_reply_follow_up_set', [req.auth!.userId, id, on]);
  });

  app.post('/replies/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = ReplyReview.parse(req.body);
    if (b.action === 'approve' || b.action === 'save') {
      const errors = b.text?.trim()
        ? b.action === 'approve'
          ? await replyApprovalErrors(deps, req.auth!.userId, b.text)
          : []
        : ['empty text'];
      if (errors.length)
        return reply.status(422).send({ error: errors.join('; '), code: 'bad_request', errors });
    }
    return callJson(deps.db, 'ext_reply_review', [
      req.auth!.userId,
      id,
      b.action,
      b.outcome,
      b.text,
    ]);
  });

  app.post('/deals/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z
      .object({
        stage: z.enum(DEAL_STAGES).nullable(),
        note: z.string().max(500).nullable().default(null),
      })
      .parse(req.body);
    return callJson(deps.db, 'ext_deal_set', [req.auth!.userId, id, b.stage, b.note]);
  });
};
