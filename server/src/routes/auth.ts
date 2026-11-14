import type { FastifyPluginAsync } from 'fastify';
import { LoginRequest, RefreshRequest, type TokenPair } from '@outreach/shared';
import type { AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { burnPasswordCheck, verifyPassword } from '../auth/passwords.ts';
import { REFRESH_TTL_S, hashToken, newRefreshToken } from '../auth/tokens.ts';

export const authRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  const limit = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } };

  async function issue(userId: string, deviceId: string): Promise<TokenPair> {
    const access = await deps.tokens.signAccess({ userId, deviceId });
    const refreshToken = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_S * 1000);
    await callJson(deps.db, 'ext_auth_store_refresh', [
      userId,
      deviceId,
      hashToken(refreshToken),
      refreshExpiresAt,
    ]);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  app.post('/login', limit, async (req) => {
    const body = LoginRequest.parse(req.body);
    const user = await callJson<{ id: string; password_hash: string; enabled: boolean } | null>(
      deps.db,
      'ext_auth_get_user',
      [body.email],
    );
    if (!user) {
      await burnPasswordCheck(body.password);
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    const ok = await verifyPassword(user.password_hash, body.password);
    if (!ok || !user.enabled) throw new HttpError(401, 'unauthorized', 'invalid credentials');
    return issue(user.id, body.deviceId);
  });

  app.post('/refresh', limit, async (req) => {
    const body = RefreshRequest.parse(req.body);
    const newToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_S * 1000);
    const res = await callJson<{
      ok: boolean;
      user_id?: string;
      device_id?: string;
      reason?: string;
    }>(deps.db, 'ext_auth_rotate_refresh', [
      hashToken(body.refreshToken),
      hashToken(newToken),
      expiresAt,
    ]);
    if (!res.ok || !res.user_id || !res.device_id) {
      throw new HttpError(401, 'unauthorized', `refresh rejected: ${res.reason ?? 'unknown'}`);
    }
    const access = await deps.tokens.signAccess({ userId: res.user_id, deviceId: res.device_id });
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt.toISOString(),
      refreshToken: newToken,
      refreshExpiresAt: expiresAt.toISOString(),
    } satisfies TokenPair;
  });

  app.post('/logout', async (req) => {
    const body = RefreshRequest.parse(req.body);
    await callJson(deps.db, 'ext_auth_revoke_refresh', [hashToken(body.refreshToken)]);
    return { ok: true };
  });
};
