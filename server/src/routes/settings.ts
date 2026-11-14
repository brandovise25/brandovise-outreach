import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';

// Settings tab: Jibran edits send times, caps and robot hours. Each key has its own validation here;
// the database function only accepts the same list of keys. Dry run, live posting and the actions the
// extension may perform are not editable here.

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Range = z.tuple([HHMM, HHMM]).refine(([a, b]) => a < b, 'start must be before end');
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const SETTING_RULES = {
  // weekday (0 = Sunday) -> list of [from, to] windows in which invites and messages may be sent
  robot_schedule: z.partialRecord(
    z.enum(['0', '1', '2', '3', '4', '5', '6']),
    z.array(Range).max(3),
  ),
  daily_invite_cap: int(0, 40),
  weekly_invite_cap: int(0, 150),
  daily_message_cap: int(0, 100),
  pending_invite_cap: int(50, 1000),
  withdraw_after_days: int(14, 120),
  job_hours: z
    .object({ from: int(0, 23), to: int(1, 24) })
    .refine((h) => h.from < h.to, 'from must be before to'),
  job_gap_seconds: z
    .object({ min: int(60, 3600), max: int(60, 7200) })
    .refine((g) => g.min <= g.max, 'min must not be above max'),
  comment_round_times: z.array(HHMM).max(4),
  comment_autopost_daily_max: int(0, 10),
  ai_daily_budget_usd: z.number().min(0).max(20),
  paused: z.boolean(),
  sync_auto: z.boolean(),
  prospect_auto: z.boolean(),
  send_auto: z.boolean(),
  auto_approve: z.boolean(),
} as const;
type Key = keyof typeof SETTING_RULES;

async function rpc<T>(deps: AppDeps, fn: string, args: unknown[]): Promise<T> {
  try {
    return await callJson<T>(deps.db, fn, args);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === '22023') throw new HttpError(400, 'bad_request', e.message ?? 'invalid');
    throw err;
  }
}

export const settingsRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/settings', async (req) => rpc(deps, 'ext_settings_for_edit', [req.auth!.userId]));
  app.post('/settings/:key', async (req) => {
    const { key } = z
      .object({ key: z.enum(Object.keys(SETTING_RULES) as [Key, ...Key[]]) })
      .parse(req.params);
    const { value } = z.object({ value: z.unknown() }).parse(req.body);
    const parsed = SETTING_RULES[key].safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        400,
        'bad_request',
        `${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return rpc(deps, 'ext_setting_set', [req.auth!.userId, key, JSON.stringify(parsed.data)]);
  });
  // "Go live" / back to dry run (Jibran, 17.10.2026). Going live needs the typed confirmation word, so
  // a stray request cannot switch real sending on.
  app.post('/live', async (req) => {
    const body = z
      .object({ live: z.boolean(), confirm: z.string().optional() })
      .refine(
        (b) => !b.live || b.confirm === 'LIVE',
        'confirm with "LIVE" to switch live sending on',
      )
      .safeParse(req.body);
    if (!body.success)
      throw new HttpError(400, 'bad_request', body.error.issues.map((i) => i.message).join('; '));
    return rpc(deps, 'ext_set_live', [req.auth!.userId, body.data.live]);
  });
};
