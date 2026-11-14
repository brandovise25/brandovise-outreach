import { z } from 'zod';
import { findBannedPhrases } from './validators.ts';
import { hasEmoji, hasUrl, normalize } from './text.ts';
import { humanizerIssues } from './humanizer.ts';

// A post as the feed / post adapters read it from the rendered page.
export const FeedPost = z.object({
  author: z.string().max(200),
  authorHeadline: z.string().max(400).nullable(),
  authorProfile: z.string().max(400).nullable(),
  authorFollowers: z.string().max(40).nullable(), // as shown: "12,345 followers"
  text: z.string().max(5000),
  relativeDate: z.string().max(40).nullable(),
  reactions: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
  media: z.enum(['none', 'image', 'video', 'document', 'carousel', 'article', 'poll']),
  promoted: z.boolean(),
  urn: z.string().max(80).nullable(), // urn:li:activity:<id> when the page shows it
  url: z.string().max(500).nullable(),
});
export type FeedPost = z.infer<typeof FeedPost>;

export const EngagementScanRequest = z.object({ posts: z.array(FeedPost).min(1).max(30) });
export type EngagementScanRequest = z.infer<typeof EngagementScanRequest>;

export const EngagementScanResult = z.object({
  seen: z.number().int(),
  alreadyKnown: z.number().int(),
  drafted: z.number().int(),
  skipped: z.number().int(),
  rejectedDrafts: z.number().int(),
  costUsd: z.number(),
});
export type EngagementScanResult = z.infer<typeof EngagementScanResult>;

// Stable identity for a post: its URN when shown, else author + start of the text.
export function postKey(p: Pick<FeedPost, 'urn' | 'author' | 'text'>): string {
  if (p.urn) return p.urn;
  const basis = `${normalize(p.author)}|${normalize(p.text).slice(0, 200)}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `post:${h.toString(36)}:${basis.length}`;
}

export function renderPosts(posts: FeedPost[]): string {
  return posts
    .map((p, i) =>
      [
        `[${i}] ${p.author}${p.authorHeadline ? ` — ${p.authorHeadline}` : ''}`,
        `    followers: ${p.authorFollowers ?? 'unknown'} | age: ${p.relativeDate ?? 'unknown'} | reactions: ${p.reactions ?? '?'} | comments: ${p.comments ?? '?'} | media: ${p.media}${p.promoted ? ' | PROMOTED' : ''}`,
        `    text: ${p.text.replace(/\s+/g, ' ').trim()}`,
      ].join('\n'),
    )
    .join('\n\n');
}

// Comment shapes (Jibran, 17.10.2026): comments of the same build read machine-written, so code draws
// a shape per post at random and the AI writes in that shape. Weights add up to 100.
export type CommentShape = 'kudos' | 'short' | 'question' | 'standard';
export const COMMENT_SHAPES: Record<
  CommentShape,
  { weight: number; min: number; max: number; instruction: string }
> = {
  kudos: {
    weight: 20,
    min: 15,
    max: 120,
    instruction:
      'KUDOS: one short line of congratulation or appreciation (15-120 characters), like a quick "Bravo, Lea, 61 Anwahlen an einem Tag!" Address the author by first name or name one concrete detail of the post. No story, no "I", no question.',
  },
  short: {
    weight: 25,
    min: 40,
    max: 220,
    instruction:
      'SHORT: one or two sentences (40-220 characters), one paragraph. React to one specific point. No closing appreciation sentence.',
  },
  question: {
    weight: 15,
    min: 60,
    max: 260,
    instruction:
      'QUESTION: one or two sentences (60-260 characters) that end with one specific question to the author about their post. No praise sentence.',
  },
  standard: {
    weight: 40,
    min: 150,
    max: 420,
    instruction:
      'STANDARD: 2-3 short paragraphs (150-420 characters). Vary the ending: a plain statement, a short personal note or nothing extra. Do not end with a sentence that praises a point of the post.',
  },
};

// Draws one shape; `rand` returns [0, 1) like Math.random (tests pass their own).
export function pickCommentShape(rand: () => number = Math.random): CommentShape {
  let r = rand() * 100;
  for (const [shape, s] of Object.entries(COMMENT_SHAPES) as [CommentShape, { weight: number }][]) {
    if ((r -= s.weight) < 0) return shape;
  }
  return 'standard';
}

// Added to the drafting request after the prompt; it overrides the prompt's length, paragraph and
// ending rules for this round.
export function shapeInstructions(shapes: CommentShape[]): string {
  const used = [...new Set(shapes)];
  return [
    'COMMENT SHAPE PER POST (set by code at random so comments do not all look alike; this overrides the length, paragraph, framework and ending rules above):',
    ...shapes.map((s, i) => `[${i}] ${s.toUpperCase()}`),
    '',
    ...used.map((s) => `- ${COMMENT_SHAPES[s].instruction}`),
    '- Never use these stock phrases: "ist stark, weil", "trifft\'s genau", "das sehe ich oft", "deckt sich mit meiner Arbeit / meinem Bild", "is the strongest part", "the strongest part".',
    '- Mention your own example (Kfz-Vergleich, Maklerbüros you work with) in at most one comment of this round.',
    '- Never grade the post ("is the right call", "ist genau die richtige Frage", "gut eingeordnet", "ist ein ehrliches Versprechen"). Do not repeat the author\'s point back to them; add a fact, an experience or a concrete question of your own.',
    '- Tell your own n8n story (over a year, hobby projects first, then clients) at most once in this round, and only when the post is about n8n.',
    '- Only bridge to automation when the post is about work, tools or processes. On other topics, comment on the topic itself or skip the post.',
  ].join('\n');
}

// Phrases that turned into a signature in the first posted comments (16.10.2026), and
// "deckt sich mit meiner Arbeit / meinem Bild" (30.10.2026: two drafts of one round).
const FORMULA_PHRASES =
  /\b(ist|sind|war) (richtig |besonders )?stark,? weil\b|trifft'?s genau|das sehe ich oft|\bdeckt sich mit (meiner|meinem|meinen)\b|\b(is|was) the strongest part\b/i;

// Praise that only restates the author's point (14.11.2026: "Kariaki, tools that only offer truly
// free slots is the right call", "Ait, ... ist ein ehrliches Versprechen", "Dominic, gut eingeordnet").
// A reader sees a summary plus a grade; this is what people call out as an AI comment. Checked in the
// first sentence, where these verdicts sit.
const PRAISE_VERDICT =
  /\b(is|was|are) (exactly |really |just )?the right (call|priority|default|move|idea|question|approach|engineering priority|thing to do|place to (dig|start))\b|\b(is|was) the (part|detail|point|bit) (that counts|that matters|i'?d care about most)\b|\bis the useful one\b|\bsays a lot about\b|\b(ist|war|sind) (genau |wirklich )?(die|der|das) richtige?n?\b|\b(ist|war) (genau )?richtig\b|\bgut eingeordnet\b|\b(ist|war) (ein|eine) (ehrliche[rs]?|kluge[rs]?|starke[rs]?|gute[rs]?|wichtige[rs]?) [\p{L}-]+\b|\b(ist|war) das detail, das\b|\bgenau die richtige frage\b/iu;
// The first sentence, or the first two when the first is only a greeting ("Congrats, Tassilo.").
const firstSentence = (t: string) => {
  const parts = t.split(/(?<=[.!?])\s+|\n/).filter(Boolean);
  return [...(parts[0] ?? t)].length < 30 ? parts.slice(0, 2).join(' ') : (parts[0] ?? t);
};
export function praiseVerdict(text: string): string | null {
  return firstSentence(text.trim()).match(PRAISE_VERDICT)?.[0] ?? null;
}

// Jibran's own project example (the Kfz-Vergleich he built).
const OWN_EXAMPLE = /kfz-vergleich/i;
// His own story with n8n ("over a year, first hobby projects, then clients"), in any wording: at most
// once among open and recent comments (14.11.2026: the same line in four comments).
const OWN_STORY =
  /(n8n[\s\S]{0,120}(over a year|more than a year|über (ein|einem) jahr|seit (über )?einem jahr|hobby)|(over a year|über (ein|einem) jahr|hobby)[\s\S]{0,120}n8n)/i;
const fiveWordRuns = (t: string) => {
  const w = normalize(t).match(/[\p{L}\d]+/gu) ?? [];
  return new Set(w.slice(4).map((_, i) => w.slice(i, i + 5).join(' ')));
};

// Repeats across comments, checked in code (30.10.2026: two drafts of one round shared the Kfz
// example): the own example at most once among open and recent comments, and no run of 5 words
// copied from one of them.
export function repeatIssues(text: string, earlier: readonly string[]): string[] {
  const issues: string[] = [];
  if (OWN_EXAMPLE.test(text) && earlier.some((e) => OWN_EXAMPLE.test(e)))
    issues.push('own example (Kfz-Vergleich) is already in another open or recent comment');
  if (OWN_STORY.test(text) && earlier.some((e) => OWN_STORY.test(e)))
    issues.push(
      'own n8n story (over a year, hobby then clients) is already in another open or recent comment',
    );
  const runs = fiveWordRuns(text);
  const hit = earlier.flatMap((e) => [...fiveWordRuns(e)]).find((r) => runs.has(r));
  if (hit) issues.push(`repeats "${hit}" from another open or recent comment`);
  return issues;
}

// Engagement comment rules that code can check (linkedin-engagement-round step 9). Without a shape
// (fact check before posting) the shape is taken from the length: short comments need no paragraphs.
export function validateComment(
  text: string,
  banned?: readonly string[],
  shape?: CommentShape,
): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = text.trim();
  const len = [...t].length;
  if (len < 15 || len > 420) errors.push(`length ${len} (allowed 15-420)`);
  // A draft that misses its shape but passes every rule is kept: only flagged, never thrown away.
  if (shape) {
    const s = COMMENT_SHAPES[shape];
    if (len < s.min || len > s.max)
      warnings.push(`length ${len} does not fit the ${shape} shape (${s.min}-${s.max})`);
    if (shape === 'question' && !t.endsWith('?'))
      warnings.push('question shape without a question');
  }
  if (len > 260 && !/\n\s*\n/.test(t)) errors.push('not split into paragraphs');
  if (FORMULA_PHRASES.test(t)) errors.push(`stock phrase: "${t.match(FORMULA_PHRASES)![0]}"`);
  const verdict = praiseVerdict(t);
  if (verdict)
    errors.push(`restates the post as praise ("${verdict}"): add something of your own instead`);
  // A question at the end is optional (Jibran, 11.10.2026: most comments end with a specific
  // appreciation instead). Generic praise is never enough on its own.
  if (
    /^(great post|great insights?|love this|well said|so true|this\.?|100\s?%|starker beitrag|toller beitrag|super beitrag|sehr guter beitrag|danke für(s)? teilen)[!.]*$/i.test(
      t.split(/\n/)[0]!.trim(),
    )
  )
    errors.push('opens with generic praise');
  if (/(^|\s)#\p{L}/u.test(t)) errors.push('contains a hashtag');
  if (hasEmoji(t)) errors.push('contains emoji');
  if (hasUrl(t)) errors.push('contains a link');
  if (/brandovise/i.test(t)) errors.push('names Brandovise');
  if (/schreib(en)? (mir|sie mir)|meld(e dich|en sie sich)|dm me|let'?s connect/i.test(t))
    errors.push('contains a call to action');
  if (/was denkt ihr\??$|what do you think\??$/i.test(t)) errors.push('generic closing question');
  const lastLine =
    t
      .split(/\n/)
      .filter((l) => l.trim())
      .pop() ?? '';
  if (
    /\b(bei euch|ihr alle|wie seht ihr|wie macht ihr|habt ihr|wer von euch|what do you all|how do you all)\b/i.test(
      lastLine,
    )
  ) {
    errors.push('closing question asks the audience, not the author');
  }
  const b = findBannedPhrases(t, banned);
  if (b.length) errors.push(`banned phrases: ${b.join(', ')}`);
  // Machine-written patterns (humanizer.ts): staged constructions are rejected so the AI rewrites the
  // comment; a vocabulary cluster or many em dashes is only flagged.
  for (const i of humanizerIssues(t)) {
    const msg = `reads AI-written: ${i.rule} ("${i.match}")`;
    if (
      i.level === 'error' ||
      [
        'negative parallelism',
        'reveal bridge',
        'staccato',
        'cliché phrase',
        'cliché opener',
      ].includes(i.rule)
    )
      errors.push(msg);
    else warnings.push(msg);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Deterministic part of the fact check before posting: the comment rules again, plus every number in
// the comment must appear in the post (no invented figures).
export function factCheckComment(
  comment: string,
  post: string,
  banned?: readonly string[],
): string[] {
  const issues = [...validateComment(comment, banned).errors];
  // Standalone numbers only: digits inside a word are names, not figures (n8n, B2B, 3D; 07.11.2026 a
  // comment about n8n was blocked as "8 not in the post").
  const nums = (t: string) =>
    new Set(
      (t.match(/(?<![\p{L}\d])\d+(?:[.,]\d+)?(?![\p{L}\d])/gu) ?? []).map((n) =>
        n.replace(',', '.'),
      ),
    );
  const inPost = nums(post);
  const invented = [...nums(comment)].filter((n) => !inPost.has(n));
  // Drafts saved before 11.10.2026 keep only the first 600 characters of the post: a number further
  // down cannot be checked here (the AI fact check still reviews the comment).
  const cutOff = [...post].length >= 590 && [...post].length <= 610;
  if (invented.length && !cutOff) issues.push(`number(s) not in the post: ${invented.join(', ')}`);
  return issues;
}

export const CommentTarget = z.object({
  id: z.number().int(),
  text: z.string(),
  post_url: z.string().nullable(),
  post_urn: z.string().nullable(),
  author_name: z.string().nullable(),
  author_headline: z.string().nullable(),
  author_profile: z.string().nullable(),
  post_excerpt: z.string().nullable(),
  live: z.boolean(),
});
export type CommentTarget = z.infer<typeof CommentTarget>;

// What the content script reports after trying to comment.
export const CommentAttempt = z.object({
  dryRun: z.boolean(),
  found: z.boolean(), // the post was found on the page
  typed: z.boolean(), // the editor holds exactly the approved text
  button: z.string().nullable(), // label of the submit button that was (or would be) pressed
  clicked: z.boolean(),
  verified: z.boolean(), // the comment appeared under the post
  postedUrl: z.string().nullable(),
  // Link of the post the robot found (saved on the draft, so the next attempt opens it directly).
  postLink: z.string().nullable().optional(),
  note: z.string(),
});
export type CommentAttempt = z.infer<typeof CommentAttempt>;

// One comment per person per week (Jibran, 21.10.2026): posts by an author Jibran commented on in the
// last 7 days, or who already has an open draft, are skipped before any AI call. Matched by profile
// path (/in/<slug> or /company/<slug>), else by name.
export const AUTHOR_PAUSE_DAYS = 7;
export interface PausedAuthor {
  name: string | null;
  profile: string | null;
  status: string;
  at: string;
}
const profileKey = (url: string | null | undefined): string | null => {
  const m = decodeURIComponent(url ?? '').match(/\/(in|company)\/([^/?#]+)/i);
  return m ? `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null;
};
const nameKey = (n: string | null | undefined) =>
  normalize(n ?? '')
    .toLowerCase()
    .replace(/[^\p{L} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function pausedAuthor(post: FeedPost, paused: PausedAuthor[]): PausedAuthor | null {
  const pk = profileKey(post.authorProfile);
  const nk = nameKey(post.author);
  return (
    paused.find((a) => {
      const ak = profileKey(a.profile);
      if (pk && ak) return pk === ak;
      return !!nk && nk === nameKey(a.name);
    }) ?? null
  );
}
