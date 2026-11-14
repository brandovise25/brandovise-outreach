import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.ts';

// Serves the web app (web/dist) at /app/. It runs as a normal page and inside the extension's side
// panel; only this server and the extension (ALLOWED_ORIGINS) may embed it.
export const webRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const root =
    process.env.WEB_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  if (!existsSync(join(root, 'index.html'))) {
    app.log.warn(`web app not built (${root}); /app is unavailable`);
    return;
  }
  const ancestors = ["'self'", ...deps.config.allowedOrigins].join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  await app.register(fastifyStatic, {
    root,
    prefix: '/app/',
    index: ['index.html'],
    setHeaders(res, path) {
      res.header('content-security-policy', csp);
      res.header('x-content-type-options', 'nosniff');
      res.header('referrer-policy', 'no-referrer');
      // Hashed assets never change; index.html must always be fresh so a deploy shows up at once.
      res.header(
        'cache-control',
        path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.get('/app', (_req, reply) => reply.redirect('/app/'));
  app.get('/', (_req, reply) => reply.redirect('/app/'));
};
