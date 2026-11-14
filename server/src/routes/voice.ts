import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  VoiceProfile,
  VoiceSamples,
  profileFindings,
  voiceFingerprint,
  voiceForPrompt,
  type VoiceFingerprint,
} from '@outreach/shared';
import { prepareProfileCheck, prepareVoiceProfile } from '../ai/tasks.ts';
import { runTask } from '../ai/run.ts';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';

// Voice profile: the extension sends samples of Jibran's own writing; the server measures them,
// lets the AI describe the voice (quotes verified), and stores a draft for Jibran to approve.

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

export async function analyzeVoice(deps: AppDeps, userId: string, raw: unknown) {
  const samples = VoiceSamples.parse(raw);
  if (samples.posts.length + samples.comments.length < 3)
    throw new HttpError(
      400,
      'bad_request',
      'need at least 3 posts or comments to describe a voice',
    );
  const fingerprint = voiceFingerprint(samples);
  const task = await prepareVoiceProfile(samples, fingerprint, { db: deps.db, userId });
  let run;
  try {
    run = await runTask<{ profile: VoiceProfile; dropped: number }>(
      deps,
      userId,
      'voice_profile',
      task,
    );
  } catch (err) {
    // Keep what the robot read, so "Try again" does not need LinkedIn again.
    await rpc(deps, 'ext_voice_keep_failed', [
      userId,
      JSON.stringify(samples),
      JSON.stringify(fingerprint),
      err instanceof Error ? err.message : String(err),
    ]);
    throw err;
  }
  const { better, ...profile } = run.output.profile;
  const saved = await rpc<{ id: number }>(deps, 'ext_voice_save', [
    userId,
    JSON.stringify(samples),
    JSON.stringify(fingerprint),
    JSON.stringify(profile),
    JSON.stringify(better),
    null,
  ]);
  return { id: saved.id, droppedQuotes: run.output.dropped, costUsd: run.costUsd, fingerprint };
}

export const voicePanelRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/voice', async (req) => rpc(deps, 'ext_voice_get', [req.auth!.userId]));
  app.post('/voice/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({
        decision: z.enum(['approve', 'reject']),
        profile: VoiceProfile.omit({ better: true }).nullable().default(null),
      })
      .parse(req.body);
    return rpc(deps, 'ext_voice_decide', [
      req.auth!.userId,
      id,
      body.decision,
      body.profile && JSON.stringify(body.profile),
    ]);
  });
};

export const voiceRetryRoute: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  // Re-run the AI on the samples of the last failed attempt.
  app.post('/voice/retry', async (req) => {
    const failed = await rpc<{ samples: unknown } | null>(deps, 'ext_voice_failed_samples', [
      req.auth!.userId,
    ]);
    if (!failed) throw new HttpError(404, 'not_found', 'no failed attempt to retry');
    return analyzeVoice(deps, req.auth!.userId, failed.samples);
  });
};

// Profile check on the newest samples the robot read (no LinkedIn visit).
export const profileCheckRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/profile-check', async (req) => rpc(deps, 'ext_profile_check_get', [req.auth!.userId]));
  app.post('/profile-check', async (req) => {
    const userId = req.auth!.userId;
    const latest = await rpc<{ id: number; samples: unknown } | null>(
      deps,
      'ext_voice_latest_samples',
      [userId],
    );
    if (!latest)
      throw new HttpError(
        404,
        'not_found',
        'build the voice profile first, so the robot has read your profile',
      );
    const samples = VoiceSamples.parse(latest.samples);
    const findings = profileFindings(samples);
    const voice = await rpc<{ profile: VoiceProfile; fingerprint: VoiceFingerprint } | null>(
      deps,
      'ext_voice_for_drafting',
      [userId],
    );
    const task = await prepareProfileCheck(
      samples,
      findings,
      voice ? voiceForPrompt(voice.profile, voice.fingerprint) : '',
      { db: deps.db, userId },
    );
    const run = await runTask<unknown>(deps, userId, 'profile_check', task);
    const saved = await rpc<{ id: number }>(deps, 'ext_profile_check_save', [
      userId,
      latest.id,
      JSON.stringify(findings),
      JSON.stringify(run.output),
    ]);
    return { id: saved.id, costUsd: run.costUsd };
  });
};

export const voiceExtRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.post('/voice/samples', { bodyLimit: 2 * 1024 * 1024 }, async (req) =>
    analyzeVoice(deps, req.auth!.userId, req.body),
  );
};
