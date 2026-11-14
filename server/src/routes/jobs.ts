import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { addToCommentLibrary } from './panel.ts';

// Job queue: rounds, syncs and posts can be started from the side panel, the remote API, or the
// auto-post planner. The extension claims one job at a time and runs it in its own window.

const JobKind = z.enum([
  'comment_round',
  'post_comment',
  'capture_sync',
  'prospect_round',
  'import_leads',
  'sync_round',
  'send_round',
  'voice_profile',
  'study_comments',
  'company_lookup',
]);
const NewJob = z.object({
  kind: JobKind,
  params: z.record(z.string(), z.unknown()).default({}),
  notBefore: z.iso.datetime().nullable().default(null),
});
const Id = z.object({ id: z.coerce.number().int().positive() });
const EventsQuery = z.object({
  job: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const LogLine = z.object({
  level: z.enum(['info', 'warn', 'error']).default('info'),
  step: z.string().max(60).nullable().default(null),
  message: z.string().max(1000),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
  progress: z.record(z.string(), z.unknown()).nullable().default(null),
});

// Read-only views shared by the side panel and the remote API.
function events(deps: AppDeps, userId: string, query: unknown) {
  const q = EventsQuery.parse(query);
  return rpc(deps, 'ext_job_events', [userId, q.job ?? null, q.limit]);
}

async function rpc<T>(deps: AppDeps, fn: string, args: unknown[]): Promise<T> {
  try {
    return await callJson<T>(deps.db, fn, args);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'P0002') throw new HttpError(404, 'not_found', e.message ?? 'not found');
    if (e.code === '22023') throw new HttpError(400, 'bad_request', e.message ?? 'invalid');
    throw err;
  }
}

export function enqueue(deps: AppDeps, userId: string, body: unknown, by: string) {
  const job = NewJob.parse(body);
  if (job.kind === 'post_comment') z.object({ id: z.number().int().positive() }).parse(job.params);
  return rpc(deps, 'ext_job_enqueue', [
    userId,
    job.kind,
    JSON.stringify(job.params),
    job.notBefore,
    by,
  ]);
}

// Side panel (signed-in user).
export const panelJobRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/jobs', async (req) => rpc(deps, 'ext_list_jobs', [req.auth!.userId]));
  app.post('/jobs', async (req) => enqueue(deps, req.auth!.userId, req.body, 'panel'));
  app.post('/jobs/:id/cancel', async (req) =>
    rpc(deps, 'ext_job_cancel', [req.auth!.userId, Id.parse(req.params).id]),
  );
  app.post('/jobs/:id/stop', async (req) =>
    rpc(deps, 'ext_job_stop', [req.auth!.userId, Id.parse(req.params).id]),
  );
  app.get('/robot', async (req) => rpc(deps, 'ext_robot', [req.auth!.userId]));
  app.get('/job-events', async (req) => events(deps, req.auth!.userId, req.query));
  app.get('/autopost', async (req) => rpc(deps, 'ext_autopost', [req.auth!.userId, null]));
  app.post('/autopost', async (req) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    return rpc(deps, 'ext_autopost', [req.auth!.userId, on]);
  });
};

// Extension worker: claim the next job, report the result.
export const extJobRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.post('/jobs/claim', async (req) => {
    const job = await rpc(deps, 'ext_job_claim', [req.auth!.userId, req.auth!.deviceId]);
    // For robot_health: when the extension last asked for work.
    await rpc(deps, 'ext_device_claimed', [req.auth!.userId, req.auth!.deviceId]);
    return { job };
  });
  // Scheduled rounds started by the extension itself.
  app.post('/jobs', async (req) => enqueue(deps, req.auth!.userId, req.body, 'schedule'));
  app.post('/jobs/:id/log', async (req) => {
    const l = LogLine.parse(req.body);
    return rpc(deps, 'ext_job_log', [
      req.auth!.userId,
      Id.parse(req.params).id,
      l.level,
      l.step,
      l.message,
      l.data && JSON.stringify(l.data),
      l.progress && JSON.stringify(l.progress),
    ]);
  });
  app.post('/jobs/:id/finish', async (req) => {
    const { status, result } = z
      .object({
        status: z.enum(['done', 'error', 'stopped']),
        result: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);
    return rpc(deps, 'ext_job_finish', [
      req.auth!.userId,
      Id.parse(req.params).id,
      status,
      JSON.stringify(result),
    ]);
  });
};

// Remote API for scripts and scheduled Claude tasks: header x-api-token (API_TOKEN). It can read the
// state, start rounds and syncs, and queue posts of comments Jibran has ALREADY approved. It can never
// approve anything itself; approving through the token happens only in the MCP server (routes/mcp.ts),
// after Jibran's yes in the chat.
export function tokenOk(req: FastifyRequest, expected: string | undefined): boolean {
  const got = req.headers['x-api-token'];
  if (!expected || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const remoteApiRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    if (!tokenOk(req, deps.config.API_TOKEN))
      throw new HttpError(401, 'unauthorized', 'invalid API token');
    const userId = await callJson<string | null>(deps.db, 'ext_api_user', []);
    if (!userId) throw new HttpError(403, 'forbidden', 'no enabled user');
    req.auth = { userId, deviceId: '00000000-0000-4000-8000-000000000000' };
  });
  app.get('/status', async (req) => ({
    dashboard: await rpc(deps, 'ext_dashboard', [req.auth!.userId]),
    autopost: await rpc(deps, 'ext_autopost', [req.auth!.userId, null]),
  }));
  app.get('/jobs', async (req) => rpc(deps, 'ext_list_jobs', [req.auth!.userId]));
  app.post('/jobs', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) =>
    enqueue(deps, req.auth!.userId, req.body, 'api'),
  );
  app.post('/jobs/:id/cancel', async (req) =>
    rpc(deps, 'ext_job_cancel', [req.auth!.userId, Id.parse(req.params).id]),
  );
  app.post('/jobs/:id/stop', async (req) =>
    rpc(deps, 'ext_job_stop', [req.auth!.userId, Id.parse(req.params).id]),
  );
  app.get('/robot', async (req) => rpc(deps, 'ext_robot', [req.auth!.userId]));
  app.get('/job-events', async (req) => events(deps, req.auth!.userId, req.query));
  app.get('/comments', async (req) => rpc(deps, 'ext_list_comments', [req.auth!.userId]));
  // Import of comments read from saved post pages (adds study material only, approves nothing).
  app.post(
    '/comment-library',
    { config: { rateLimit: { max: 200, timeWindow: '1 hour' } } },
    async (req) =>
      addToCommentLibrary(deps, req.auth!.userId, { source: 'import', ...(req.body as object) }),
  );
};
