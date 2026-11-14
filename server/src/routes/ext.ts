import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  DocResponse,
  ExtSettings,
  HeartbeatRequest,
  HeartbeatResponse,
  Limits,
  ProspectLookup,
  SaveAnalysisRequest,
  isVersionAllowed,
} from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';

export const extRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });

  // Every ext route except heartbeat refuses extension versions below ext_min_version.
  async function settingsFor(userId: string) {
    return ExtSettings.parse(await callJson(deps.db, 'ext_get_settings', [userId]));
  }
  async function assertVersion(userId: string, version: unknown) {
    const settings = await settingsFor(userId);
    if (typeof version !== 'string' || !isVersionAllowed(version, settings.ext_min_version)) {
      throw new HttpError(
        426,
        'version_too_old',
        `extension version below ${settings.ext_min_version}`,
      );
    }
    return settings;
  }

  app.post('/heartbeat', async (req) => {
    const body = HeartbeatRequest.parse(req.body);
    const auth = req.auth!;
    if (body.deviceId !== auth.deviceId) throw new HttpError(403, 'forbidden', 'device mismatch');
    const res = await callJson(deps.db, 'ext_heartbeat', [
      auth.userId,
      body.deviceId,
      body.name,
      body.version,
      body.userAgent,
      body.lastError,
    ]);
    return HeartbeatResponse.parse(res);
  });

  app.get('/settings', async (req) => {
    return assertVersion(req.auth!.userId, req.headers['x-extension-version']);
  });

  app.get('/docs/:key', async (req) => {
    await assertVersion(req.auth!.userId, req.headers['x-extension-version']);
    const { key } = z.object({ key: z.string().regex(/^[a-z_]{1,40}$/) }).parse(req.params);
    try {
      return DocResponse.parse(await callJson(deps.db, 'ext_get_doc', [req.auth!.userId, key]));
    } catch (err) {
      if ((err as { code?: string }).code === '42501')
        throw new HttpError(404, 'not_found', 'unknown doc');
      throw err;
    }
  });

  app.get('/limits', async (req) => {
    await assertVersion(req.auth!.userId, req.headers['x-extension-version']);
    return Limits.parse(await callJson(deps.db, 'ext_limits', [req.auth!.userId]));
  });

  app.get('/prospect', async (req) => {
    await assertVersion(req.auth!.userId, req.headers['x-extension-version']);
    const { url } = z.object({ url: z.string().url().max(400) }).parse(req.query);
    return ProspectLookup.parse(
      await callJson(deps.db, 'ext_lookup_prospect', [req.auth!.userId, url]),
    );
  });

  app.post('/analysis', async (req) => {
    await assertVersion(req.auth!.userId, req.headers['x-extension-version']);
    const body = SaveAnalysisRequest.parse(req.body);
    try {
      return await callJson(deps.db, 'ext_save_analysis', [
        req.auth!.userId,
        body.prospectId,
        body.fit ? JSON.stringify(body.fit) : null,
        body.trigger ? JSON.stringify(body.trigger) : null,
        body.activity ? JSON.stringify(body.activity) : null,
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === 'P0002')
        throw new HttpError(404, 'not_found', 'unknown prospect');
      throw err;
    }
  });
};
