import { companyRoutes } from './routes/companies.ts';
import { replyRoutes } from './routes/replies.ts';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { HttpError } from './errors.ts';
import { TokenService, type AccessClaims } from './auth/tokens.ts';
import { OpenRouterClient } from './ai/openrouter.ts';
import { authRoutes } from './routes/auth.ts';
import { extRoutes } from './routes/ext.ts';
import { aiRoutes } from './routes/ai.ts';
import { healthRoutes } from './routes/health.ts';
import { panelRoutes } from './routes/panel.ts';
import { webRoutes } from './routes/web.ts';
import { extJobRoutes, panelJobRoutes, remoteApiRoutes } from './routes/jobs.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { settingsRoutes } from './routes/settings.ts';
import { textsRoutes } from './routes/texts.ts';
import { sendPreviewRoutes, sendRoutes, syncRoutes } from './routes/sync.ts';
import { prospectRoutes } from './routes/prospect.ts';
import {
  profileCheckRoutes,
  voiceExtRoutes,
  voicePanelRoutes,
  voiceRetryRoute,
} from './routes/voice.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  tokens: TokenService;
  openrouter?: OpenRouterClient;
  webFetch?: typeof fetch; // outside searches (Serper, OpenStreetMap); tests put a fake here
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      deps.config.NODE_ENV === 'test'
        ? false
        : { level: 'info', redact: ['req.headers.authorization'] },
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Requests without Origin (curl, server-to-server) are allowed; auth still applies.
      if (!origin || deps.config.allowedOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    methods: ['GET', 'POST'],
  });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.message, code: err.code });
    }
    if (err instanceof ZodError) {
      // Which fields failed (names and rule only, never the values), so a rejected sync can be traced.
      _req.log.warn(
        {
          url: _req.url,
          issues: err.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.code}`),
        },
        'validation failed',
      );
      return reply.status(400).send({ error: 'invalid request', code: 'bad_request' });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.status(429).send({ error: 'too many requests', code: 'forbidden' });
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message, code: 'bad_request' });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal error', code: 'internal' });
  });

  await app.register(healthRoutes, { deps });
  await app.register(authRoutes, { deps, prefix: '/auth' });
  await app.register(extRoutes, { deps, prefix: '/ext' });
  await app.register(aiRoutes, { deps, prefix: '/ai' });
  await app.register(panelRoutes, { deps, prefix: '/panel' });
  await app.register(panelJobRoutes, { deps, prefix: '/panel' });
  await app.register(extJobRoutes, { deps, prefix: '/ext' });
  await app.register(voicePanelRoutes, { deps, prefix: '/panel' });
  await app.register(voiceRetryRoute, { deps, prefix: '/panel' });
  await app.register(profileCheckRoutes, { deps, prefix: '/panel' });
  await app.register(settingsRoutes, { deps, prefix: '/panel' });
  await app.register(textsRoutes, { deps, prefix: '/panel' });
  await app.register(voiceExtRoutes, { deps, prefix: '/ext' });
  await app.register(syncRoutes, { deps, prefix: '/ext' });
  await app.register(sendRoutes, { deps, prefix: '/ext' });
  await app.register(prospectRoutes, { deps, prefix: '/ext' });
  await app.register(sendPreviewRoutes, { deps, prefix: '/panel' });
  await app.register(companyRoutes, { deps, prefix: '/panel' });
  await app.register(replyRoutes, { deps, prefix: '/panel' });
  await app.register(remoteApiRoutes, { deps, prefix: '/api' });
  await app.register(mcpRoutes, { deps, prefix: '/mcp' });
  await app.register(webRoutes, { deps });

  return app;
}

// Verifies the bearer token and that the user is still enabled.
export async function requireAuth(deps: AppDeps, req: FastifyRequest): Promise<AccessClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'unauthorized', 'missing token');
  let claims: AccessClaims;
  try {
    claims = await deps.tokens.verifyAccess(header.slice(7));
  } catch {
    throw new HttpError(401, 'unauthorized', 'invalid token');
  }
  const { rows } = await deps.db.query('select public.ext_auth_user_enabled($1) as ok', [
    claims.userId,
  ]);
  if (rows[0]?.ok !== true) throw new HttpError(403, 'forbidden', 'user disabled');
  req.auth = claims;
  return claims;
}
