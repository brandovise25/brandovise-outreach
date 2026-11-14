import { z } from 'zod';
import { Position } from './snapshots.ts';

// Prospect round: contracts and the hard skips in code (from the routine's rule 5, learned from the
// reply review of 21.09.2026). The AI screen and the fit check come on top; these never let a pool or
// insurer employee through, whatever the model says.

export const HARD_SKIP_EMPLOYER =
  /\b(fonds finanz|qualitypool|hypoport|blau direkt|sdv\b|afm\b|mrh trowe|r\+v|nürnberger|nuernberger|arag|allianz|dvag|ergo\b|axa\b|signal iduna|hdi\b|generali|debeka|huk[- ]coburg|gothaer|barmenia|continentale|jung dms|vema\b|netfonds|maxpool|apella)\b/i;
export const HARD_SKIP_TITLE =
  /\b(maklerbetreuer(in)?|bereichsleiter(in)?|vertriebskoordinator(in)?|produktmanager(in)?|bezirksdirektor(in)?|key account|account manager|recruiter|azubi|auszubildende[r]?|trainee|werkstudent(in)?|angehende[r]?|in ausbildung|student(in)?)\b/i;

export function hardSkip(headline: string | null | undefined): string | null {
  const h = headline ?? '';
  const t = h.match(HARD_SKIP_TITLE);
  if (t) return `hard skip: title "${t[0]}"`;
  const e = h.match(HARD_SKIP_EMPLOYER);
  if (e) return `hard skip: works for "${e[0]}" (pool, insurer or large broker group)`;
  return null;
}

export const KeywordSet = z.object({
  keyword: z.string().min(2).max(120),
  segment: z.string().max(60),
  campaign: z.string().max(80).nullable(),
  stage_only: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type KeywordSet = z.infer<typeof KeywordSet>;

export const ProspectPlan = z.object({
  run_id: z.number(),
  mode: z.enum(['approve', 'stage']),
  why: z.string().nullable(),
  waiting: z.number(),
  max_approve: z.number(),
  keywords: z.array(KeywordSet),
});
export type ProspectPlan = z.infer<typeof ProspectPlan>;

export const SearchCard = z.object({
  name: z.string().max(200),
  profileUrl: z.string().max(400),
  degree: z.enum(['1st', '2nd', '3rd']).nullable(),
  headline: z.string().max(400).nullable(),
  location: z.string().max(200).nullable(),
  snippet: z.string().max(400).nullable(),
  action: z.enum(['connect', 'pending', 'message', 'follow']).nullable(),
});
export type SearchCard = z.infer<typeof SearchCard>;

export const ScreenOutput = z.object({
  items: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      verdict: z.enum(['open', 'reject']),
      score: z.number().int().min(0).max(100),
      reason: z.string().transform((s) => s.slice(0, 300)),
    }),
  ),
});

export const AssessInput = z.object({
  runId: z.number().int(),
  keyword: z.string().max(120),
  segment: z.string().max(60),
  campaign: z.string().max(80).nullable(),
  stageOnly: z.boolean(),
  mode: z.enum(['approve', 'stage']),
  maxApprove: z.number().int(),
  score: z.number().int(),
  manual: z.boolean().optional(), // a profile Jibran named himself: never rejected by the fit check
  website: z.string().max(300).nullable().optional(), // the company's website, when known
  companyId: z.number().int().positive().nullable().optional(), // a company already in the tracker
  card: SearchCard,
  profile: z.object({
    name: z.string().max(200),
    headline: z.string().max(400).nullable(),
    location: z.string().max(200).nullable(),
    about: z.string().max(4000).nullable(),
    canConnect: z.boolean(),
    pending: z.boolean(),
    connected: z.boolean(),
    experience: z.array(Position).max(15),
  }),
});
export type AssessInput = z.infer<typeof AssessInput>;
