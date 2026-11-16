import type { FastifyPluginAsync } from 'fastify';
import { InboundAssessInput, type VerifiedFit } from '@outreach/shared';
import { prepareFitCheck } from '../ai/tasks.ts';
import { runTask } from '../ai/run.ts';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';

// Incoming connections (Jibran, 16.11.2026): the sync round opens the profile of someone who connected
// without being invited by the robot; this runs the fit check against each active campaign. The first
// clear "yes" enrolls the person (thank-you message for Jibran's approval, then the campaign's
// follow-ups). Otherwise the person is listed in Leads without a message.

interface Campaign {
  id: string;
  status: string;
  invited?: number;
}

export async function assessInbound(
  deps: AppDeps,
  userId: string,
  input: InboundAssessInput,
  check: (campaignId: string) => Promise<VerifiedFit> = async (campaignId) => {
    const task = await prepareFitCheck(
      {
        campaignId,
        profile: {
          url: input.url,
          fullName: input.profile.name,
          headline: input.profile.headline,
          location: input.profile.location,
          degree: '1st',
          about: input.profile.about,
          experience: input.profile.experience,
          actionState: 'unknown',
          language: 'de',
        },
      },
      { db: deps.db, userId },
    );
    return (await runTask<VerifiedFit>(deps, userId, 'fit_check', task)).output;
  },
) {
  const campaigns = (await callJson<Campaign[]>(deps.db, 'ext_list_campaigns', [userId]))
    .filter((c) => c.status === 'on')
    .sort((a, b) => (b.invited ?? 0) - (a.invited ?? 0));
  const company =
    input.profile.experience.find((e) => /present|heute/i.test(e.dates ?? ''))?.company ?? null;
  const base = { name: input.profile.name, headline: input.profile.headline, company };

  let best: { campaign: string; fit: VerifiedFit } | null = null;
  for (const c of campaigns) {
    const fit = await check(c.id);
    if (fit.status === 'yes') {
      return callJson<{ status: string }>(deps.db, 'ext_inbound_assessed', [
        userId,
        input.url,
        JSON.stringify({ ...base, status: 'fit', campaign_id: c.id, fit }),
      ]);
    }
    if (!best || (fit.status === 'unsure' && best.fit.status === 'no'))
      best = { campaign: c.id, fit };
  }
  return callJson<{ status: string }>(deps.db, 'ext_inbound_assessed', [
    userId,
    input.url,
    JSON.stringify({
      ...base,
      status: best?.fit.status === 'unsure' ? 'unsure' : 'no_fit',
      campaign_id: best?.fit.status === 'unsure' ? best.campaign : null,
      fit: best?.fit ?? null,
      reason: best
        ? `${best.fit.status} for ${best.campaign}: ${best.fit.reason}`
        : 'no active campaign',
    }),
  ]);
}

export const inboundRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.post('/inbound/assess', async (req) => {
    const input = InboundAssessInput.parse(req.body);
    try {
      return await assessInbound(deps, req.auth!.userId, input);
    } catch (err) {
      // AI unavailable or budget: the extension reports a failed try (at most 3, then given up).
      const e = err as { code?: string; message?: string };
      if (e.code === 'P0002') throw new HttpError(404, 'not_found', e.message ?? 'not found');
      if (e.code === '22023') throw new HttpError(400, 'bad_request', e.message ?? 'invalid');
      throw err;
    }
  });
  // A person whose profile could not be read: counts as a failed try.
  app.post('/inbound/failed', async (req) => {
    const { url } = InboundAssessInput.pick({ url: true }).parse(req.body);
    return callJson(deps.db, 'ext_inbound_assessed', [
      req.auth!.userId,
      url,
      JSON.stringify({ status: 'failed' }),
    ]);
  });
};
