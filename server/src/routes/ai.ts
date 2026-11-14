import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { AiRequest, AiTaskName, type AiResponse } from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { HttpError } from '../errors.ts';
import { prepareTask } from '../ai/tasks.ts';
import { runTask } from '../ai/run.ts';

export const aiRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });

  app.post(
    '/:task',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const taskName = AiTaskName.safeParse((req.params as { task?: string }).task);
      if (!taskName.success) throw new HttpError(404, 'not_found', 'unknown task');
      const body = AiRequest.parse(req.body);
      const userId = req.auth!.userId;
      if (!deps.openrouter)
        throw new HttpError(503, 'upstream_error', 'AI is not configured on this server');

      let task;
      try {
        task = await prepareTask(taskName.data, body.input, { db: deps.db, userId });
      } catch (err) {
        if (err instanceof ZodError) throw new HttpError(400, 'bad_request', 'invalid task input');
        throw err;
      }
      const run = await runTask(deps, userId, taskName.data, task, {
        runId: body.runId,
        prospectId: body.prospectId,
      });
      return run satisfies AiResponse;
    },
  );
};
