import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SIGNALS } from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { SECRET_NAMES, setSecret } from '../secrets.ts';
import { cleanDomain } from '../web/profile-company.ts';
import { kickCompanyQueue } from '../web/company-worker.ts';
import { OFFICE_KINDS, findOffices, searchCompanies, type OfficeKind } from '../web/discover.ts';

// Companies and their signals (plan 13.11.2026): add company websites, list them with a cohort filter,
// and the write-only keys in Settings.

export const companyRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });

  // Pasted websites (one per line, or a CSV with the website in any column), at most 200 per call.
  app.post('/companies', async (req) => {
    const b = z
      .object({
        text: z.string().max(60_000),
        campaign: z.string().max(80).nullable().default(null),
        segment: z.string().max(60).nullable().default(null),
      })
      .parse(req.body);
    const domains = [
      ...new Set(
        b.text
          .split(/[\s,;"']+/)
          .map((t) => (/\.[a-z]{2,}/i.test(t) && !t.includes('@') ? cleanDomain(t) : null))
          .filter((d): d is string => !!d),
      ),
    ].slice(0, 200);
    if (!domains.length)
      throw new HttpError(400, 'bad_request', 'No website addresses found in the text.');
    const r = await callJson<{ added: number; known: number }>(deps.db, 'ext_company_upsert', [
      req.auth!.userId,
      JSON.stringify(
        domains.map((domain) => ({
          domain,
          source: 'manual',
          campaign_id: b.campaign,
          segment: b.segment,
        })),
      ),
    ]);
    kickCompanyQueue(deps);
    return { found: domains.length, added: r.added, known: r.known };
  });

  app.get('/companies', async (req) => {
    const q = z
      .object({
        codes: z.string().max(400).default(''),
        q: z.string().max(80).default(''),
        limit: z.coerce.number().int().min(1).max(300).default(100),
      })
      .parse(req.query);
    const codes = q.codes.split(',').filter((c) => c in SIGNALS);
    return callJson(deps.db, 'ext_company_list', [req.auth!.userId, codes, q.q, q.limit]);
  });

  // ---------- finding companies ----------

  app.get('/companies/search-usage', async (req) => {
    const u = await callJson<Record<string, unknown>>(deps.db, 'ext_search_usage', [
      req.auth!.userId,
    ]);
    const keys = await callJson<Record<string, unknown>>(deps.db, 'ext_secret_status', [
      req.auth!.userId,
    ]);
    return { ...u, has_key: 'serper_api_key' in keys, office_kinds: OFFICE_KINDS };
  });
  app.post(
    '/companies/search',
    { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z
        .object({
          query: z.string().trim().min(3).max(200),
          pages: z.number().int().min(1).max(3).default(1),
          campaign: z.string().max(80).nullable().default(null),
          segment: z.string().max(60).nullable().default(null),
        })
        .parse(req.body);
      const r = await searchCompanies(deps, req.auth!.userId, b, deps.webFetch);
      kickCompanyQueue(deps);
      return r;
    },
  );
  app.post(
    '/companies/offices',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req) => {
      const b = z
        .object({
          city: z.string().max(80),
          kind: z.enum(Object.keys(OFFICE_KINDS) as [OfficeKind, ...OfficeKind[]]),
          campaign: z.string().max(80).nullable().default(null),
        })
        .parse(req.body);
      const r = await findOffices(deps, req.auth!.userId, b, deps.webFetch);
      kickCompanyQueue(deps);
      return r;
    },
  );
  app.post('/companies/campaign', async (req) => {
    const b = z
      .object({
        campaign: z.string().min(1).max(80),
        ids: z.array(z.number().int().positive()).max(300).nullable().default(null),
      })
      .parse(req.body);
    return callJson(deps.db, 'ext_company_set_campaign', [req.auth!.userId, b.ids, b.campaign]);
  });

  // The robot's part: whose owner to look up on LinkedIn, and what came of it.
  app.post('/companies/lookup-plan', async (req) => {
    const { max } = z
      .object({ max: z.number().int().min(1).max(8).default(5) })
      .parse(req.body ?? {});
    return callJson(deps.db, 'ext_company_lookup_plan', [req.auth!.userId, max]);
  });
  app.post('/companies/:id/lookup', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(['found', 'not_found', 'duplicate']) })
      .parse(req.body);
    return callJson(deps.db, 'ext_company_lookup_done', [req.auth!.userId, id, status]);
  });

  // How each opening did (which website fact an invite or first message referred to).
  app.get('/message-stats', async (req) =>
    callJson(deps.db, 'ext_message_stats', [req.auth!.userId]),
  );

  app.get('/secrets', async (req) => callJson(deps.db, 'ext_secret_status', [req.auth!.userId]));
  app.post(
    '/secrets/:name',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req) => {
      const { name } = z.object({ name: z.enum(SECRET_NAMES) }).parse(req.params);
      const { value } = z.object({ value: z.string().max(300) }).parse(req.body);
      await setSecret(deps, req.auth!.userId, name, value);
      return { ok: true, set: value.trim() !== '' };
    },
  );
};
