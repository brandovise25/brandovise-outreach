import { z } from 'zod';
import {
  FitCheckInput,
  FitOutput,
  TriggerExtractInput,
  TriggerOutput,
  quoteAppears,
  renderActivity,
  renderProfile,
  triggerFresh,
  verifyFit,
  renderPosts,
  validateComment,
  repeatIssues,
  pickCommentShape,
  shapeInstructions,
  type CommentShape,
  VoiceProfile,
  ScreenOutput,
  type SearchCard,
  ProfileRewrites,
  inventedNumbers,
  type ProfileFinding,
  verifyVoice,
  voiceForPrompt,
  type VoiceFingerprint,
  type VoiceSamples,
  type FeedPost,
  type AiTaskName,
  type TriggerType,
  type VerifiedFit,
  type VerifiedTrigger,
  examplesBlock,
  guessLang,
  type CommentExamples,
  type StudyPost,
  type StudyStats,
  REPLY_CLASSES,
  type ReplyClass,
} from '@outreach/shared';
import type { Db } from '../db.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import type { CompletionRequest } from './openrouter.ts';

export interface PreparedTask {
  version: number;
  request: CompletionRequest;
  // Parses the model output and applies the deterministic checks. Throws ZodError on schema mismatch.
  verify(output: unknown): unknown;
}

interface PromptRow {
  version: number;
  model: string;
  fallback_models: string[];
  system_prompt: string;
  user_template: string;
  json_schema: Record<string, unknown>;
  temperature: number | null;
  max_tokens: number;
}

interface Ctx {
  db: Db;
  userId: string;
  now?: Date;
}

// Page text must not be able to close the <page_data> block it is wrapped in.
export function fenceUntrusted(text: string): string {
  return text.replace(/<\/?\s*(page_data|rules)\b/gi, (m) => m.replace('<', '‹'));
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template variable missing: ${k}`);
    return vars[k]!;
  });
}

async function loadPrompt(ctx: Ctx, task: string): Promise<PromptRow> {
  const row = await callJson<PromptRow | null>(ctx.db, 'ext_get_prompt', [ctx.userId, task]);
  if (!row) throw new HttpError(503, 'upstream_error', `no active prompt for ${task}`);
  return row;
}

function toRequest(p: PromptRow, task: string, user: string): CompletionRequest {
  return {
    model: p.model,
    fallbackModels: p.fallback_models ?? [],
    system: p.system_prompt,
    user,
    schemaName: task,
    schema: p.json_schema,
    temperature: p.temperature === null ? null : Number(p.temperature),
    maxTokens: p.max_tokens,
  };
}

function berlinDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(now);
}

const PingOutput = z.object({ pong: z.literal(true), echo: z.string().max(100) });

async function preparePing(input: Record<string, unknown>): Promise<PreparedTask> {
  const word = String(input.word ?? 'hello').slice(0, 50);
  return {
    version: 0,
    request: {
      model: 'anthropic/claude-haiku-5.5',
      fallbackModels: ['openai/gpt-6-luna'],
      system: 'You are a connectivity test. Reply only with the JSON the schema requires.',
      user: `Set pong to true and echo to this word: ${word}`,
      schemaName: 'ping',
      schema: {
        type: 'object',
        properties: { pong: { type: 'boolean' }, echo: { type: 'string' } },
        required: ['pong', 'echo'],
        additionalProperties: false,
      },
      temperature: null,
      maxTokens: 50,
    },
    verify: (o) => PingOutput.parse(o),
  };
}

export async function prepareFitCheck(
  raw: Record<string, unknown>,
  ctx: Ctx,
): Promise<PreparedTask> {
  const input = FitCheckInput.parse(raw);
  const targetGroup = await callJson<string | null>(ctx.db, 'ext_target_group', [
    ctx.userId,
    input.campaignId,
  ]);
  if (!targetGroup?.trim()) {
    throw new HttpError(
      400,
      'bad_request',
      `campaign ${input.campaignId} has no target-group description`,
    );
  }
  const profileText = renderProfile(input.profile);
  const prompt = await loadPrompt(ctx, 'fit_check');
  const user = renderTemplate(prompt.user_template, {
    campaign_id: input.campaignId,
    target_group: targetGroup,
    profile: fenceUntrusted(profileText),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'fit_check', user),
    verify(o): VerifiedFit {
      const fit = FitOutput.parse(o);
      const checked = verifyFit(fit, profileText);
      const checks: string[] = [];
      if (checked.evidence.length < fit.evidence.length) {
        checks.push(
          `${fit.evidence.length - checked.evidence.length} evidence quote(s) not found on the page and dropped`,
        );
      }
      if (checked.downgraded)
        checks.push(`${fit.status} downgraded to unsure: no verifiable evidence`);
      return { ...checked, checks };
    },
  };
}

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?/;

async function prepareTriggerExtract(
  raw: Record<string, unknown>,
  ctx: Ctx,
): Promise<PreparedTask> {
  const input = TriggerExtractInput.parse(raw);
  const sourceText = renderActivity(input.profile, input.activity);
  const rules = await callJson<{ body: string }>(ctx.db, 'ext_get_doc', [
    ctx.userId,
    'trigger_rules',
  ]);
  const prompt = await loadPrompt(ctx, 'trigger_extract');
  const now = ctx.now ?? new Date();
  const user = renderTemplate(prompt.user_template, {
    today: berlinDate(now),
    trigger_rules: rules.body,
    activity: fenceUntrusted(sourceText),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'trigger_extract', user),
    verify(o): VerifiedTrigger {
      const t = TriggerOutput.parse(o);
      const checks: string[] = [];
      const none = (why: string): VerifiedTrigger => {
        checks.push(why);
        return {
          type: 'none',
          note: '',
          detail_quote: '',
          url: '',
          date: '',
          date_is_approx: false,
          rejected: true,
          checks,
        };
      };
      if (t.type === 'none') return { ...t, rejected: false, checks };
      if (!quoteAppears(t.detail_quote, sourceText))
        return none(`${t.type} rejected: detail quote is not on the page`);
      const date = ISO_DATE.test(t.date) ? { iso: t.date } : { relative: t.date };
      if (!t.date || !triggerFresh(t.type as TriggerType, date, now)) {
        return none(`${t.type} rejected: date "${t.date}" missing or older than the maximum age`);
      }
      let url = t.url;
      if (url && !sourceText.includes(url)) {
        checks.push('url not on the page, removed');
        url = '';
      }
      return { ...t, url, rejected: false, checks };
    },
  };
}

export async function prepareTask(
  name: AiTaskName,
  input: Record<string, unknown>,
  ctx: Ctx,
): Promise<PreparedTask> {
  switch (name) {
    case 'ping':
      return preparePing(input);
    case 'fit_check':
      return prepareFitCheck(input, ctx);
    case 'trigger_extract':
      return prepareTriggerExtract(input, ctx);
  }
}

// ---------- engagement_pick: choose posts to comment on and draft the comments ----------

export interface EngagementItem {
  index: number;
  verdict: 'draft' | 'skip';
  reason: string;
  reach_note: string;
  marketing_level: 0 | 1 | 2;
  comment: string;
}

const EngagementOutput = z.object({
  posts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      verdict: z.enum(['draft', 'skip']),
      reason: z.string().transform((s) => s.slice(0, 400)),
      reach_note: z.string().transform((s) => s.slice(0, 300)),
      marketing_level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      comment: z.string().max(2000),
    }),
  ),
});

export async function prepareEngagementPick(
  posts: FeedPost[],
  ctx: Ctx,
  banned: string[],
  shapes: CommentShape[] = posts.map(() => pickCommentShape()),
  earlier: readonly string[] = [], // open and recent comments, for the repeat check
): Promise<PreparedTask> {
  const rules = await callJson<{ body: string }>(ctx.db, 'ext_get_doc', [
    ctx.userId,
    'engagement_rules',
  ]);
  const prompt = await loadPrompt(ctx, 'engagement_pick');
  // Jibran's approved voice profile ('' until he approves one in the Voice tab).
  const voice = await callJson<{ profile: VoiceProfile; fingerprint: VoiceFingerprint } | null>(
    ctx.db,
    'ext_voice_for_drafting',
    [ctx.userId],
  );
  // Style references from the comment library (Jibran's good/bad marks, well-liked real comments).
  const examples = await callJson<CommentExamples | null>(ctx.db, 'ext_comment_examples', [
    ctx.userId,
  ]);
  const user = renderTemplate(prompt.user_template, {
    today: berlinDate(ctx.now ?? new Date()),
    engagement_rules: rules.body,
    voice: voice ? voiceForPrompt(voice.profile, voice.fingerprint) : '',
    posts: fenceUntrusted(renderPosts(posts)),
  });
  return {
    version: prompt.version,
    request: toRequest(
      prompt,
      'engagement_pick',
      [user, examplesBlock(examples), shapeInstructions(shapes)].filter(Boolean).join('\n\n'),
    ),
    // Keeps one entry per known post; at most 5 drafts; a draft that breaks the comment rules becomes
    // a skip with the reason, so nothing unchecked reaches the side panel.
    verify(o): EngagementItem[] {
      const parsed = EngagementOutput.parse(o).posts.filter((p) => p.index < posts.length);
      const seen = new Set<number>();
      const taken = [...earlier];
      let drafts = 0;
      return parsed
        .filter((p) => (seen.has(p.index) ? false : (seen.add(p.index), true)))
        .map((p) => {
          if (p.verdict !== 'draft') return { ...p, comment: '', marketing_level: 0 as const };
          if (++drafts > 5)
            return { ...p, verdict: 'skip' as const, comment: '', reason: 'more than 5 drafts' };
          const check = validateComment(p.comment, banned, shapes[p.index]);
          // Same language as the post (21.10.2026: a German comment landed on an English post).
          const postLang = guessLang(posts[p.index]!.text);
          const commentLang = guessLang(p.comment);
          if (postLang && commentLang && postLang !== commentLang)
            check.errors.push(`written in ${commentLang} but the post is in ${postLang}`);
          check.errors.push(...repeatIssues(p.comment, taken));
          if (!check.ok || check.errors.length) {
            return {
              ...p,
              verdict: 'skip' as const,
              comment: '',
              reason: `draft failed checks: ${check.errors.join('; ')}`,
            };
          }
          taken.push(p.comment);
          return p;
        });
    },
  };
}

// ---------- comment_factcheck: compare a comment with the post before posting ----------

const FactCheckOutput = z.object({
  verdict: z.enum(['ok', 'block']),
  issues: z.array(z.string().transform((s) => s.slice(0, 200))).transform((a) => a.slice(0, 6)),
});
export type FactCheck = z.infer<typeof FactCheckOutput>;

export async function prepareCommentFactcheck(
  input: { author: string; headline: string; post: string; comment: string },
  ctx: Ctx,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'comment_factcheck');
  const user = renderTemplate(prompt.user_template, {
    author: fenceUntrusted(input.author),
    headline: fenceUntrusted(input.headline),
    post: fenceUntrusted(input.post),
    comment: input.comment,
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'comment_factcheck', user),
    verify: (o): FactCheck => {
      const r = FactCheckOutput.parse(o);
      // "block" without a reason is treated as a block with a generic reason, never as ok.
      return r.verdict === 'block' && !r.issues.length
        ? { verdict: 'block', issues: ['fact check blocked it without a reason'] }
        : r;
    },
  };
}

// ---------- voice_profile: how Jibran writes, from his own posts, comments and profile ----------

export async function prepareVoiceProfile(
  samples: VoiceSamples,
  fingerprint: VoiceFingerprint,
  ctx: Ctx,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'voice_profile');
  const body = [
    `PROFILE\nName: ${samples.profile.name}\nHeadline: ${samples.profile.headline ?? ''}\nAbout: ${samples.profile.about ?? ''}`,
    `Experience: ${samples.profile.experience.map((e) => `${e.title}${e.company ? ` at ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}`).join('; ')}`,
    ...samples.posts.map((p, i) => `POST ${i + 1}${p.date ? ` (${p.date})` : ''}:\n${p.text}`),
    ...samples.comments.map(
      (c, i) =>
        `COMMENT ${i + 1}${c.date ? ` (${c.date})` : ''}${c.on ? ` on: ${c.on}` : ''}:\n${c.text}`,
    ),
  ].join('\n\n');
  const user = renderTemplate(prompt.user_template, {
    fingerprint: JSON.stringify(fingerprint, null, 1),
    samples: fenceUntrusted(body),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'voice_profile', user),
    verify: (o) => verifyVoice(VoiceProfile.parse(o), samples),
  };
}

// ---------- profile_check: rewrites for Jibran's own profile, numbers only from his texts ----------

export async function prepareProfileCheck(
  samples: VoiceSamples,
  findings: ProfileFinding[],
  voice: string,
  ctx: Ctx,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'profile_check');
  const p = samples.profile;
  const body = [
    `PROFILE\nName: ${p.name}\nHeadline: ${p.headline ?? ''}\nLocation: ${p.location ?? ''}\nURL: ${p.url ?? ''}\nAbout: ${p.about ?? ''}`,
    `EXPERIENCE\n${p.experience.map((e) => `- ${e.title}${e.company ? `, ${e.company}` : ''}${e.dates ? ` (${e.dates})` : ''}${e.description ? `: ${e.description}` : ''}`).join('\n')}`,
    ...samples.posts.map((x, i) => `POST ${i}${x.date ? ` (${x.date})` : ''}:\n${x.text}`),
  ].join('\n\n');
  const user = renderTemplate(prompt.user_template, {
    findings: findings.map((f) => `${f.section}: ${f.status} - ${f.note}`).join('\n'),
    voice,
    samples: fenceUntrusted(body),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'profile_check', user),
    verify: (o) => {
      const r = ProfileRewrites.parse(o);
      const texts = [...r.headline_options, r.about, r.current_role.description];
      const invented = [...new Set(texts.flatMap((t) => inventedNumbers(t, samples)))];
      // An invented number is a schema-level failure: the task is retried.
      if (invented.length)
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['about'],
            message: `invented numbers: ${invented.join(', ')}`,
            input: invented,
          },
        ]);
      return {
        ...r,
        featured_post_indexes: r.featured_post_indexes.filter((i) => i < samples.posts.length),
      };
    },
  };
}

// ---------- prospect_screen: which people-search results are worth opening ----------

export async function prepareProspectScreen(
  cards: SearchCard[],
  keyword: string,
  segment: string,
  ctx: Ctx,
): Promise<PreparedTask> {
  const rules = await callJson<{ body: string }>(ctx.db, 'ext_get_doc', [
    ctx.userId,
    'targeting_rules',
  ]);
  const prompt = await loadPrompt(ctx, 'prospect_screen');
  const results = cards
    .map(
      (c, i) =>
        `[${i}] ${c.name}${c.degree ? ` (${c.degree})` : ''}\nHeadline: ${c.headline ?? ''}\nLocation: ${c.location ?? ''}${c.snippet ? `\n${c.snippet}` : ''}`,
    )
    .join('\n\n');
  const user = renderTemplate(prompt.user_template, {
    segment,
    keyword,
    targeting_rules: rules.body,
    results: fenceUntrusted(results),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'prospect_screen', user),
    verify: (o) => ScreenOutput.parse(o).items.filter((x) => x.index < cards.length),
  };
}

// ---------- comment_study: how people really comment, and a new DRAFTING section ----------

const StudyPostLabel = z.object({
  index: z.number().int(),
  topic: z.string().transform((s) => s.slice(0, 300)),
  kind: z.enum(['question', 'story', 'opinion', 'announcement', 'how-to', 'event', 'other']),
  asks_readers: z.boolean(),
  best_comment: z.number().int(),
  why: z.string().transform((s) => s.slice(0, 400)),
});
export type StudyPostLabel = z.infer<typeof StudyPostLabel>;
const StudyPostsOutput = z.object({ posts: z.array(StudyPostLabel) });

// Since 14.11.2026 the per-post labels come from their own call (comment_study_posts); a prompt
// version that still returns them here is accepted.
const StudyOutput = z.object({
  posts: z.array(StudyPostLabel).default([]),
  findings: z.object({
    summary: z
      .string()
      .min(40)
      .transform((s) => s.slice(0, 2000)),
    by_kind: z
      .array(
        z.object({
          kind: z.string().transform((s) => s.slice(0, 60)), // the model writes labels like "announcement / event invitation …"
          how_people_comment: z.string().transform((s) => s.slice(0, 600)),
        }),
      )
      .transform((a) => a.slice(0, 8)),
    relevance: z.string().transform((s) => s.slice(0, 1000)),
    jibran_differs: z
      .array(z.string().transform((s) => s.slice(0, 300)))
      .transform((a) => a.slice(0, 10)),
    copy: z.array(z.string().transform((s) => s.slice(0, 300))).transform((a) => a.slice(0, 10)),
    avoid: z.array(z.string().transform((s) => s.slice(0, 300))).transform((a) => a.slice(0, 10)),
  }),
  drafting: z.string().min(80).max(6000),
});
export type StudyResult = z.infer<typeof StudyOutput>;

function renderStudyPosts(posts: StudyPost[]): string {
  return posts
    .map((p, i) => {
      const cs = p.comments
        .map(
          (c, j) =>
            `  [${j}]${c.is_mine ? ' [JIBRAN]' : ''}${c.is_reply ? ' (reply)' : ''} ${c.author}${c.reactions ? ` (${c.reactions} likes)` : ''}: ${c.text.replace(/\s+/g, ' ').slice(0, 600)}`,
        )
        .join('\n');
      return `POST ${i} by ${p.author ?? '?'}:\n${(p.excerpt ?? '').slice(0, 1200)}\nCOMMENTS:\n${cs}`;
    })
    .join('\n\n');
}

export async function prepareCommentStudy(
  posts: StudyPost[],
  stats: StudyStats,
  currentRules: string,
  ctx: Ctx,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'comment_study');
  const drafting =
    currentRules.match(/^DRAFTING[^\n]*\n[\s\S]*?(?=^MARKETING LEVEL:|(?![\s\S]))/m)?.[0] ?? '';
  const user = renderTemplate(prompt.user_template, {
    stats: JSON.stringify(stats, null, 1),
    current_drafting: drafting || '(none)',
    posts: fenceUntrusted(renderStudyPosts(posts)),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'comment_study', user),
    verify(o): StudyResult {
      const r = StudyOutput.parse(o);
      return {
        ...r,
        posts: r.posts.filter((p) => p.index >= 0 && p.index < posts.length),
        // the brand name and links never enter the rules, whatever the model wrote
        drafting: r.drafting.replace(/brandovise/gi, 'Jibran').replace(/https?:\/\/\S+/g, ''),
      };
    },
  };
}

export async function prepareCommentStudyPosts(
  posts: StudyPost[],
  ctx: Ctx,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'comment_study_posts');
  const user = renderTemplate(prompt.user_template, {
    posts: fenceUntrusted(renderStudyPosts(posts)),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'comment_study_posts', user),
    verify: (o): StudyPostLabel[] =>
      StudyPostsOutput.parse(o).posts.filter((p) => p.index >= 0 && p.index < posts.length),
  };
}

// ---------- invite_note: the personal part of a connection request ----------

const InviteNotesOutput = z.object({
  notes: z.array(
    z.object({
      index: z.number().int(),
      note: z.string().transform((s) => s.trim().slice(0, 600)),
    }),
  ),
});
export interface InviteNoteInput {
  first_name: string | null;
  full_name: string;
  headline: string | null;
  company: string | null;
  facts: string[]; // verbatim evidence from the fit analysis
  hook?: { fact: string; angle: string; hint: string } | null; // chosen in code from the company's website
}

// What each offer angle of the playbook means, in the words the model gets.
const ANGLES: Record<string, string> = {
  support: 'a support chat for e-mail and WhatsApp that is connected to the shop',
  forecast: 'demand forecasts and product recommendations from past sales',
  office: 'AI agents that take over office routine',
};
const angleText = (angle: string) => ANGLES[angle] ?? angle;

export async function prepareInviteNotes(
  items: InviteNoteInput[],
  ctx: Ctx,
  audience = 'insurance and finance brokers',
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'invite_note');
  const text = items
    .map(
      (it, i) =>
        `ITEM ${i}: ${it.full_name}\nHeadline: ${it.headline ?? '-'}\nCompany: ${it.company ?? '-'}\nFacts: ${it.facts.map((f) => `"${f.slice(0, 200)}"`).join(' | ') || '-'}${
          it.hook
            ? `\nHOOK: ${it.hook.fact}\nHOW: ${it.hook.hint || '-'}\nANGLE: ${angleText(it.hook.angle)}`
            : ''
        }`,
    )
    .join('\n\n');
  const user = renderTemplate(prompt.user_template, {
    today: berlinDate(ctx.now ?? new Date()),
    audience,
    items: fenceUntrusted(text),
  });
  // Jibran's approved voice profile, so notes sound like him (none until he approves one).
  const voice = await callJson<{ profile: VoiceProfile } | null>(ctx.db, 'ext_voice_for_drafting', [
    ctx.userId,
  ]);
  const voiceBlock = voice
    ? `JIBRAN'S VOICE (his approved voice profile; match its tone, address form and rhythm. The note rules above still decide length, salutation and facts):\n${voiceForPrompt(voice.profile)}`
    : '';
  return {
    version: prompt.version,
    request: toRequest(prompt, 'invite_note', [user, voiceBlock].filter(Boolean).join('\n\n')),
    verify(o): { index: number; note: string }[] {
      const seen = new Set<number>();
      return InviteNotesOutput.parse(o).notes.filter(
        (n) =>
          n.index >= 0 && n.index < items.length && !seen.has(n.index) && (seen.add(n.index), true),
      );
    },
  };
}

// ---------- message_opener: the opening of the first message, from a website fact ----------

const OpenerOutput = z.object({ opener: z.string().transform((s) => s.trim().slice(0, 400)) });
export interface OpenerInput {
  full_name: string;
  headline: string | null;
  company: string | null;
  hook: { fact: string; angle: string; hint: string };
  message: string; // Jibran's campaign text that follows
}

export async function prepareMessageOpener(
  input: OpenerInput,
  ctx: Ctx,
  audience: string,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'message_opener');
  const person = `Person: ${input.full_name}\nHeadline: ${input.headline ?? '-'}\nCompany: ${input.company ?? '-'}\nHOOK: ${input.hook.fact}`;
  const user = renderTemplate(prompt.user_template, {
    audience,
    angle: angleText(input.hook.angle),
    hint: input.hook.hint || '-',
    person: fenceUntrusted(person),
    message: fenceUntrusted(input.message.slice(0, 2500)),
  });
  return {
    version: prompt.version,
    request: toRequest(prompt, 'message_opener', user),
    verify(o): string {
      return OpenerOutput.parse(o).opener;
    },
  };
}

// ---------- classify_reply / draft_reply: answers to people who wrote back ----------

const ReplyClassesOutput = z.object({
  replies: z.array(
    z.object({
      index: z.number().int(),
      class: z.enum(REPLY_CLASSES),
      reason: z.string().transform((s) => s.trim().slice(0, 300)),
    }),
  ),
});
export interface ReplyInput {
  full_name: string;
  headline: string | null;
  company: string | null;
  snippet: string;
  last_sent: string | null;
}
const threadText = (r: ReplyInput) =>
  `From: ${r.full_name}${r.company ? ` (${r.company})` : ''}\nHeadline: ${r.headline ?? '-'}\nJIBRAN WROTE BEFORE: ${r.last_sent ? r.last_sent.slice(0, 1200) : '-'}\nTHEIR REPLY: ${r.snippet.slice(0, 1000)}`;

export async function prepareClassifyReplies(items: ReplyInput[], ctx: Ctx): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'classify_reply');
  const text = items.map((it, i) => `ITEM ${i}\n${threadText(it)}`).join('\n\n');
  return {
    version: prompt.version,
    request: toRequest(
      prompt,
      'classify_reply',
      renderTemplate(prompt.user_template, { items: fenceUntrusted(text) }),
    ),
    verify(o): { index: number; class: ReplyClass; reason: string }[] {
      const seen = new Set<number>();
      return ReplyClassesOutput.parse(o).replies.filter(
        (r) =>
          r.index >= 0 && r.index < items.length && !seen.has(r.index) && (seen.add(r.index), true),
      );
    },
  };
}

const ReplyDraftOutput = z.object({ reply: z.string().transform((s) => s.trim().slice(0, 2000)) });

export async function prepareDraftReply(
  input: ReplyInput & { class: ReplyClass },
  ctx: Ctx,
  audience: string,
): Promise<PreparedTask> {
  const prompt = await loadPrompt(ctx, 'draft_reply');
  const rules = await callJson<{ body: string }>(ctx.db, 'ext_get_doc', [
    ctx.userId,
    'reply_rules',
  ]);
  const user = renderTemplate(prompt.user_template, {
    today: berlinDate(ctx.now ?? new Date()),
    class: input.class,
    audience,
    rules: rules.body.trim() || '-',
    thread: fenceUntrusted(threadText(input)),
  });
  const voice = await callJson<{ profile: VoiceProfile } | null>(ctx.db, 'ext_voice_for_drafting', [
    ctx.userId,
  ]);
  const voiceBlock = voice
    ? `JIBRAN'S VOICE (his approved voice profile; match its tone and rhythm. The rules above still decide form and length):\n${voiceForPrompt(voice.profile)}`
    : '';
  return {
    version: prompt.version,
    request: toRequest(prompt, 'draft_reply', [user, voiceBlock].filter(Boolean).join('\n\n')),
    verify(o): string {
      return ReplyDraftOutput.parse(o).reply;
    },
  };
}
