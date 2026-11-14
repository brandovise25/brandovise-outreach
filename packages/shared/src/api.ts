import { z } from 'zod';

// API contract between the extension and the self-hosted server.
// Every request and response body is validated on both sides.

export const LoginRequest = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
  deviceId: z.uuid(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TokenPair = z.object({
  accessToken: z.string(),
  accessExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
  refreshExpiresAt: z.iso.datetime(),
});
export type TokenPair = z.infer<typeof TokenPair>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(20) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const HeartbeatRequest = z.object({
  deviceId: z.uuid(),
  name: z.string().max(80),
  version: z.string().max(40),
  userAgent: z.string().max(400),
  lastError: z.string().max(2000).nullable(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({ ok: z.literal(true), serverTime: z.iso.datetime() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const ExtAction = z.enum(['scan', 'analyze', 'draft', 'send']);
export type ExtAction = z.infer<typeof ExtAction>;

export const RunCaps = z.object({
  max_profile_visits: z.number().int().positive(),
  max_page_loads: z.number().int().positive(),
});

// Only the keys the extension is allowed to see; the server filters the rest.
export const ExtSettings = z.object({
  paused: z.boolean(),
  ext_enabled_actions: z.array(ExtAction),
  ext_dry_run: z.boolean(),
  ext_min_version: z.string(),
  run_caps: RunCaps,
  pacing: z.record(z.string(), z.unknown()),
  run_schedule: z.unknown(),
  robot_schedule: z.unknown(),
  comment_round_times: z.array(z.string()).nullable().optional(),
  sync_auto: z.boolean().optional(),
  prospect_auto: z.boolean().optional(),
  send_auto: z.boolean().optional(),
});
export type ExtSettings = z.infer<typeof ExtSettings>;

export const InviteStatus = z.enum([
  'open',
  'daily_cap',
  'weekly_cap',
  'linkedin_warning',
  'paused_until',
  'pending_cap',
  'pending_unknown',
  'robot_paused',
]);

// Shape of outreach.limits(); extra columns are passed through untouched.
export const Limits = z.looseObject({
  invite_status: InviteStatus,
  invites_allowed_now: z.number().int(),
  messages_allowed_now: z.number().int(),
  invites_resume_at: z.string().nullable(),
});
export type Limits = z.infer<typeof Limits>;

export const DocResponse = z.object({ key: z.string(), body: z.string() });
export type DocResponse = z.infer<typeof DocResponse>;

export const AiTaskName = z.enum(['ping', 'fit_check', 'trigger_extract']);
export type AiTaskName = z.infer<typeof AiTaskName>;

export const AiRequest = z.object({
  input: z.record(z.string(), z.unknown()),
  runId: z.number().int().positive().optional(),
  prospectId: z.number().int().positive().optional(),
});
export type AiRequest = z.infer<typeof AiRequest>;

export const AiResponse = z.object({
  output: z.unknown(),
  model: z.string(),
  promptVersion: z.number().int(),
  costUsd: z.number().nonnegative(),
  usage: z.object({ promptTokens: z.number().int(), completionTokens: z.number().int() }),
});
export type AiResponse = z.infer<typeof AiResponse>;

export const ApiError = z.object({
  error: z.string(),
  code: z.enum([
    'unauthorized',
    'forbidden',
    'version_too_old',
    'budget_exhausted',
    'bad_request',
    'not_found',
    'upstream_error',
    'internal',
  ]),
});
export type ApiError = z.infer<typeof ApiError>;

export const CampaignRef = z.object({ id: z.string(), name: z.string(), status: z.string() });

export const ProspectLookup = z.object({
  found: z.boolean(),
  linkedin_url: z.string().nullable(),
  id: z.number().int().optional(),
  full_name: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  stage: z.string().optional(),
  campaign_id: z.string().nullable().optional(),
  target_group: z.string().nullable().optional(),
  fit: z.unknown().optional(),
  trigger: z.unknown().optional(),
  campaigns: z.array(CampaignRef),
});
export type ProspectLookup = z.infer<typeof ProspectLookup>;

export const SaveAnalysisRequest = z.object({
  prospectId: z.number().int().positive(),
  fit: z
    .object({
      status: z.enum(['yes', 'no', 'unsure']),
      reason: z.string().max(400),
      evidence: z.array(z.string().max(400)).max(5),
    })
    .nullable(),
  trigger: z
    .object({
      type: z.enum([
        'post',
        'role_change',
        'hiring',
        'company_news',
        'shared_event',
        'shared_topic',
        'none',
      ]),
      note: z.string().max(400),
      detail_quote: z.string().max(600),
      url: z.string().max(500),
      date: z.string().max(60),
      date_is_approx: z.boolean(),
    })
    .nullable(),
  activity: z
    .object({
      last_post_url: z.string().max(500).nullable(),
      last_post_snippet: z.string().max(300).nullable(),
    })
    .nullable(),
});
export type SaveAnalysisRequest = z.infer<typeof SaveAnalysisRequest>;
