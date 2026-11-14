import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.ts';

export const healthRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get('/health', async (_req, reply) => {
    try {
      await deps.db.query('select 1');
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });
};
