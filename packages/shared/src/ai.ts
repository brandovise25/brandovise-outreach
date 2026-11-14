import { z } from 'zod';
import { ActivitySnapshot, ProfileSnapshot } from './snapshots.ts';

export const FitCheckInput = z.object({ campaignId: z.string().max(80), profile: ProfileSnapshot });
export type FitCheckInput = z.infer<typeof FitCheckInput>;

// Over-long strings are shortened rather than rejected; length is not a reason to throw away a verdict.
const clip = (n: number) =>
  z.string().transform((s) => (s.length > n ? s.slice(0, n - 1) + '…' : s));

export const FitOutput = z.object({
  status: z.enum(['yes', 'no', 'unsure']),
  reason: clip(300),
  evidence: z.array(clip(400)).transform((a) => a.slice(0, 5)),
});
export type FitOutput = z.infer<typeof FitOutput>;

export const TriggerExtractInput = z.object({
  profile: ProfileSnapshot,
  activity: ActivitySnapshot.nullable(),
});
export type TriggerExtractInput = z.infer<typeof TriggerExtractInput>;

export const TriggerOutput = z.object({
  type: z.enum([
    'post',
    'role_change',
    'hiring',
    'company_news',
    'shared_event',
    'shared_topic',
    'none',
  ]),
  note: clip(200),
  detail_quote: z.string().max(600),
  url: z.string().max(500),
  date: clip(60),
  date_is_approx: z.boolean(),
});
export type TriggerOutput = z.infer<typeof TriggerOutput>;

// What the server returns after its deterministic checks. `checks` lists what was changed and why.
export const VerifiedFit = FitOutput.extend({
  downgraded: z.boolean(),
  checks: z.array(z.string()),
});
export type VerifiedFit = z.infer<typeof VerifiedFit>;
export const VerifiedTrigger = TriggerOutput.extend({
  rejected: z.boolean(),
  checks: z.array(z.string()),
});
export type VerifiedTrigger = z.infer<typeof VerifiedTrigger>;
