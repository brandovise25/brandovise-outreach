import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AssessInput,
  ProspectPlan,
  SearchCard,
  hardSkip,
  type VerifiedFit,
} from '@outreach/shared';
import { prepareFitCheck, prepareProspectScreen } from '../ai/tasks.ts';
import { runTask } from '../ai/run.ts';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { cleanDomain } from '../web/profile-company.ts';
import { kickCompanyQueue } from '../web/company-worker.ts';

// Prospect round, server side. The extension reads LinkedIn; the server decides: plan (gate + keywords),
// screen (duplicates, hard skips, AI screen of the cards), assess (fit check on the opened profile,
// approved / staged / rejected), finish. Every person looked at gets a candidates row.

const OPEN_BAR = 60; // screen score needed before a profile is opened

async function rpc<T>(deps: AppDeps, fn: string, args: unknown[]): Promise<T> {
  try {
    return await callJson<T>(deps.db, fn, args);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === '22023') throw new HttpError(400, 'bad_request', e.message ?? 'invalid');
    throw err;
  }
}
const slug = (u: string) =>
  decodeURIComponent(u)
    .match(/\/in\/([^/?#]+)/)?.[1]
    ?.toLowerCase() ?? u;

export const prospectRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });

  app.post('/prospect/plan', async (req) =>
    ProspectPlan.parse(await rpc(deps, 'ext_prospect_plan', [req.auth!.userId])),
  );

  app.post('/prospect/screen', async (req) => {
    const userId = req.auth!.userId;
    const b = z
      .object({
        runId: z.number().int(),
        keyword: z.string().max(120),
        segment: z.string().max(60),
        campaign: z.string().max(80).nullable(),
        cards: z.array(SearchCard).max(30),
      })
      .parse(req.body);
    const known = new Set(
      (
        await rpc<string[]>(deps, 'ext_prospect_known', [userId, b.cards.map((c) => c.profileUrl)])
      ).map(slug),
    );
    const rows: Record<string, unknown>[] = [];
    const fresh: SearchCard[] = [];
    for (const c of b.cards) {
      const base = {
        full_name: c.name,
        headline: c.headline,
        company: null,
        linkedin_url: c.profileUrl,
        segment: b.segment,
        keyword: b.keyword,
      };
      const skip = hardSkip(c.headline);
      if (known.has(slug(c.profileUrl)))
        rows.push({
          ...base,
          verdict: 'duplicate',
          reason: 'already in the tracker or looked at in the last 90 days',
        });
      else if (c.action === 'pending' || c.degree === '1st')
        rows.push({
          ...base,
          verdict: 'duplicate',
          reason: c.degree === '1st' ? 'already connected' : 'invitation already pending',
        });
      else if (skip) rows.push({ ...base, verdict: 'rejected', reason: skip });
      else fresh.push(c);
    }
    let open: { card: SearchCard; score: number; reason: string }[] = [];
    let costUsd = 0;
    if (fresh.length) {
      const task = await prepareProspectScreen(fresh, b.keyword, b.segment, {
        db: deps.db,
        userId,
      });
      const run = await runTask<
        { index: number; verdict: 'open' | 'reject'; score: number; reason: string }[]
      >(deps, userId, 'prospect_screen', task);
      costUsd = run.costUsd;
      const byIndex = new Map(run.output.map((x) => [x.index, x]));
      fresh.forEach((c, i) => {
        const s = byIndex.get(i);
        if (s && s.verdict === 'open' && s.score >= OPEN_BAR)
          open.push({ card: c, score: s.score, reason: s.reason });
        else
          rows.push({
            full_name: c.name,
            headline: c.headline,
            company: null,
            linkedin_url: c.profileUrl,
            segment: b.segment,
            keyword: b.keyword,
            score: s?.score ?? null,
            verdict: 'rejected',
            reason: s ? `screen: ${s.reason}` : 'not rated by the screen',
          });
      });
      open = open.sort((x, y) => y.score - x.score);
    }
    if (rows.length)
      await rpc(deps, 'ext_prospect_record', [userId, b.runId, JSON.stringify(rows)]);
    return { open, recorded: rows.length, costUsd };
  });

  app.post('/prospect/assess', async (req) => {
    const userId = req.auth!.userId;
    const a = AssessInput.parse(req.body);
    const base = {
      full_name: a.profile.name || a.card.name,
      headline: a.profile.headline ?? a.card.headline,
      company:
        a.profile.experience.find((e) => /present|heute/i.test(e.dates ?? ''))?.company ?? null,
      linkedin_url: a.card.profileUrl,
      segment: a.segment,
      keyword: a.keyword,
      score: a.score,
      campaign_id: a.campaign,
    };
    // The person's company, when its website is known: its site is read in the background and the
    // signals show on the lead.
    let companyId = a.companyId ?? null;
    const domain = a.website ? cleanDomain(a.website) : null;
    if (!companyId && domain) {
      const up = await rpc<{ ids: Record<string, number> }>(deps, 'ext_company_upsert', [
        userId,
        JSON.stringify([
          {
            domain,
            name: base.company,
            source: 'linkedin',
            campaign_id: a.campaign,
            segment: a.segment,
          },
        ]),
      ]);
      companyId = up.ids[domain] ?? null;
      kickCompanyQueue(deps);
    }
    const record = async (verdict: string, reason: string) => {
      const r = await rpc(deps, 'ext_prospect_record', [
        userId,
        a.runId,
        JSON.stringify([{ ...base, verdict, reason }]),
      ]);
      if (companyId && (verdict === 'staged' || verdict === 'approved'))
        await rpc(deps, 'ext_company_link', [userId, companyId, a.card.profileUrl]);
      return r;
    };
    if (a.profile.pending || a.profile.connected) {
      await record(
        'duplicate',
        a.profile.connected ? 'already connected' : 'invitation already pending',
      );
      return { verdict: 'duplicate' };
    }
    let fit: VerifiedFit | null = null;
    let costUsd = 0;
    if (a.campaign) {
      const task = await prepareFitCheck(
        {
          campaignId: a.campaign,
          profile: {
            url: a.card.profileUrl,
            fullName: base.full_name,
            headline: base.headline,
            location: a.profile.location,
            degree: a.card.degree,
            about: a.profile.about,
            experience: a.profile.experience,
            actionState: a.profile.canConnect ? 'can_connect' : 'unknown',
            language: 'de',
          },
        },
        { db: deps.db, userId },
      );
      const run = await runTask<VerifiedFit>(deps, userId, 'fit_check', task);
      fit = run.output;
      costUsd = run.costUsd;
    }
    // A profile Jibran picked himself always reaches Leads; a 'no' fit is shown as the reason.
    if (fit?.status === 'no' && !a.manual) {
      await record('rejected', `fit: ${fit.reason}`);
      return { verdict: 'rejected', reason: fit.reason, costUsd };
    }
    // approved only with a clear fit, in approve mode, for a routed campaign, within the gate
    const approvedSoFar = await rpc<number>(deps, 'ext_prospect_approved_in_run', [
      userId,
      a.runId,
    ]);
    const approve =
      fit?.status === 'yes' && a.mode === 'approve' && !a.stageOnly && approvedSoFar < a.maxApprove;
    const reason = fit
      ? `fit ${fit.status}: ${fit.reason}`
      : 'no campaign for this segment yet: staged for review';
    // Staged leads stay candidates until Jibran approves them in the Leads tab (that creates the prospect).
    if (!approve) {
      await record('staged', reason);
      return { verdict: 'staged', reason, costUsd };
    }
    const added = await rpc<{ added: boolean; stage?: string }>(deps, 'ext_prospect_add', [
      userId,
      a.runId,
      JSON.stringify({
        ...base,
        location: a.profile.location,
        degree: a.card.degree,
        stage: 'approved',
        fit,
      }),
    ]);
    if (!added.added) {
      await record('duplicate', 'already in the tracker');
      return { verdict: 'duplicate', costUsd };
    }
    await record('approved', reason);
    return { verdict: 'approved', reason, costUsd };
  });

  app.post('/prospect/finish', async (req) => {
    const b = z
      .object({
        runId: z.number().int(),
        status: z.enum(['ok', 'partial', 'failed', 'aborted']),
        summary: z.record(z.string(), z.unknown()),
        notes: z.string().max(500),
      })
      .parse(req.body);
    return rpc(deps, 'ext_prospect_finish', [
      req.auth!.userId,
      b.runId,
      b.status,
      JSON.stringify(b.summary),
      b.notes,
    ]);
  });
};
