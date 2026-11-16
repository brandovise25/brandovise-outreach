import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SyncPayload, matchSync, type SyncTarget } from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { prepareQueue } from '../prepare.ts';
import { kickReplies } from '../replies.ts';

// The extension sends what the sync round read; the server matches it to prospects and applies the
// stage changes (the database triggers schedule or cancel the next steps).
export const syncRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.post('/sync', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const userId = req.auth!.userId;
    const { jobId, ...rest } = z
      .object({ jobId: z.number().int().nullable().default(null) })
      .passthrough()
      .parse(req.body);
    const payload = SyncPayload.parse(rest);
    const targets = await callJson<SyncTarget[]>(deps.db, 'ext_sync_targets', [userId]);
    const m = matchSync(targets, payload);
    const applied = await callJson<{ accepted: number; replied: number; pending: number | null }>(
      deps.db,
      'ext_sync_apply',
      [
        userId,
        JSON.stringify(m.accepted.map(({ id, at }) => ({ id, at }))),
        JSON.stringify(m.replied.map(({ id, snippet }) => ({ id, snippet }))),
        m.pending,
        jobId,
      ],
    );
    // New replies are sorted and answers drafted in the background (for approval, never sent).
    if (applied.replied > 0) kickReplies(deps, userId);
    // New connections the robot did not invite: recorded; up to 3 come back for a fit check.
    const inbound = await callJson<{ added: number; to_check: { url: string; name: string }[] }>(
      deps.db,
      'ext_inbound_record',
      [
        userId,
        JSON.stringify(
          payload.connections.map((c) => ({
            url: c.profileUrl,
            name: c.name,
            headline: c.headline ?? null,
            connectedOn: c.connectedOn,
          })),
        ),
        JSON.stringify(payload.sent.items.map((s) => s.profileUrl)),
        JSON.stringify(payload.received.map((r) => r.profileUrl)),
      ],
    );
    return {
      ...applied,
      inboundAdded: inbound.added,
      inboundToCheck: inbound.to_check,
      acceptedNames: m.accepted.map((a) => a.name),
      repliedNames: m.replied.map((r) => r.name),
      unsure: m.unsure,
      read: {
        connections: payload.connections.length,
        sent: payload.sent.items.length,
        inbox: payload.inbox.length,
      },
    };
  });
};

// Send round: the extension asks for the next items (all checks are in ext_send_batch) and reports each
// result. While dry run is on, every result is a practice result and nothing changes in the queue.
export const sendRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/send/batch', async (req) => {
    const { max } = z
      .object({ max: z.coerce.number().int().min(1).max(10).default(5) })
      .parse(req.query);
    // Due invites and follow-ups are prepared (and, with auto_approve, approved) before the batch is built.
    await prepareQueue(deps, req.auth!.userId).catch((err) =>
      req.log.warn({ err }, 'prepare failed'),
    );
    return callJson(deps.db, 'ext_send_batch', [req.auth!.userId, max]);
  });
  app.post('/send/:id/result', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const b = z
      .object({
        practice: z.boolean(),
        ok: z.boolean(),
        note: z.string().max(1000),
        detail: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    try {
      return await callJson(deps.db, 'ext_send_result', [
        req.auth!.userId,
        id,
        b.practice,
        b.ok,
        b.note,
        JSON.stringify(b.detail),
      ]);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === '22023') throw new HttpError(400, 'bad_request', e.message ?? 'invalid');
      if (e.code === 'P0002') throw new HttpError(404, 'not_found', e.message ?? 'not found');
      throw err;
    }
  });
};

// Side panel: what the next send round would do (no LinkedIn visit).
export const sendPreviewRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/send/preview', async (req) =>
    callJson(deps.db, 'ext_send_batch', [req.auth!.userId, 10]),
  );
};
