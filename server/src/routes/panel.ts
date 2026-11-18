import type { FastifyPluginAsync } from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CommentAttempt,
  CommentTarget,
  EngagementScanRequest,
  factCheckComment,
  validateComment,
  EngagementScanResult,
  rulesForAction,
  isVersionAllowed,
  postKey,
  validateDraft,
  ExtSettings,
  CommentLibraryAdd,
  clip,
  wellFormed,
  guessLang,
  replaceDraftingSection,
  studyStats,
  type StudyPost,
  AUTHOR_PAUSE_DAYS,
  pausedAuthor,
  type PausedAuthor,
} from '@outreach/shared';
import {
  prepareCommentFactcheck,
  prepareCommentStudy,
  prepareCommentStudyPosts,
  type StudyPostLabel,
  type StudyResult,
  prepareEngagementPick,
  type EngagementItem,
  type FactCheck,
} from '../ai/tasks.ts';
import { runTask } from '../ai/run.ts';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';
import { prepareQueue } from '../prepare.ts';

// Side-panel data: dashboard, approval queue, leads, comment drafts, activity.
// Approving never sends anything; sending is Phase 4.

const Id = z.object({ id: z.coerce.number().int().positive() });
const SCAN_BATCH = 10;
const QueueReview = z.object({
  decision: z.enum(['approve', 'reject', 'later', 'save']),
  text: z.string().max(8000).nullable().default(null),
});
const LeadReview = z.object({
  decision: z.enum(['approve', 'reject']),
  campaignId: z.string().max(80).nullable().default(null),
  reason: z.string().max(300).nullable().default(null),
});
const CommentReview = z.object({
  decision: z.enum(['approve', 'reject', 'posted', 'save']),
  text: z.string().max(3000).nullable().default(null),
});

// SQL errors raised by the ext_* functions map to HTTP errors.
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

// Open drafts and comments posted in the last 7 days: the texts a new draft must not repeat.
async function recentComments(deps: AppDeps, userId: string): Promise<string[]> {
  type List = { items: { comment_draft: string | null; posted_at: string | null }[] };
  const since = Date.now() - 7 * 86_400_000;
  const [open, posted] = await Promise.all(
    ['open', 'posted'].map((f) => rpc<List>(deps, 'ext_list_comments_filtered', [userId, f])),
  );
  return [
    ...open!.items,
    ...posted!.items.filter((c) => c.posted_at && Date.parse(c.posted_at) >= since),
  ]
    .map((c) => c.comment_draft ?? '')
    .filter(Boolean);
}

async function bannedPhrases(deps: AppDeps, userId: string): Promise<string[]> {
  const doc = await callJson<{ body: string }>(deps.db, 'ext_get_doc', [userId, 'banned_phrases']);
  return doc.body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Approval checks shared by the side panel and the MCP server: the deterministic checks run on the
// final text, whoever wrote it. An empty list means the text may be approved.
export async function queueApprovalErrors(
  deps: AppDeps,
  userId: string,
  id: number,
  text: string | null,
): Promise<string[]> {
  const rows = await rpc<{ id: number; action: string; message_text: string | null }[]>(
    deps,
    'ext_list_queue',
    [userId],
  );
  const row = rows.find((r) => r.id === id);
  if (!row) throw new HttpError(404, 'not_found', 'row is not waiting for approval');
  const final = text ?? row.message_text ?? '';
  // An invite may go without a note.
  if (!final && row.action === 'connect') return [];
  return validateDraft(final, rulesForAction(row.action, await bannedPhrases(deps, userId))).errors;
}

// strict (MCP): Claude gets no override, so the full comment rules apply too.
export async function commentApprovalErrors(
  deps: AppDeps,
  userId: string,
  text: string,
  strict = false,
): Promise<string[]> {
  const banned = await bannedPhrases(deps, userId);
  const result = validateDraft(text, { maxChars: 1250, bannedPhrases: banned });
  // Comments may use "du" when the author does; only banned phrases, emoji and links block approval.
  const errors = result.errors.filter((e) => !e.startsWith('uses du-form'));
  if (strict) errors.push(...validateComment(text, banned).errors);
  return [...new Set(errors)];
}

// Shared by the panel (robot) and the remote API (import of saved pages).
export async function addToCommentLibrary(deps: AppDeps, userId: string, body: unknown) {
  const b = wellFormed(CommentLibraryAdd.parse(body));
  const items = b.comments.map((c) => ({ ...c, lang: guessLang(c.text) }));
  return rpc(deps, 'ext_comment_samples_add', [
    userId,
    JSON.stringify({ ...b.post, excerpt: b.post.excerpt ? clip(b.post.excerpt, 1500) : null }),
    JSON.stringify(items),
    b.source,
  ]);
}

export const panelRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  // The web app (browser tab or side panel) uses these routes too, so the extension version is only
  // checked when an extension sends one: an outdated extension is still refused.
  app.addHook('preHandler', async (req) => {
    const auth = await requireAuth(deps, req);
    const version = req.headers['x-extension-version'];
    if (typeof version !== 'string') return;
    const settings = ExtSettings.parse(await callJson(deps.db, 'ext_get_settings', [auth.userId]));
    if (!isVersionAllowed(version, settings.ext_min_version)) {
      throw new HttpError(
        426,
        'version_too_old',
        `extension version below ${settings.ext_min_version}`,
      );
    }
  });

  app.get('/dashboard', async (req) => rpc(deps, 'ext_dashboard', [req.auth!.userId]));
  // Funnel per campaign: invited -> accepted -> messaged -> replied -> hot -> meeting -> won (18.11.2026).
  app.get('/funnel', async (req) => {
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(3650).optional() })
      .parse(req.query);
    return rpc(deps, 'ext_funnel', [req.auth!.userId, days ?? null]);
  });
  app.get('/queue', async (req) => rpc(deps, 'ext_list_queue', [req.auth!.userId]));
  // Prepares due invites and follow-ups (see prepare.ts); the Approve tab calls it, then lists the queue.
  app.post(
    '/queue/prepare',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req) => prepareQueue(deps, req.auth!.userId),
  );
  app.get('/leads', async (req) => rpc(deps, 'ext_list_leads', [req.auth!.userId]));
  app.get('/comments', async (req) => rpc(deps, 'ext_list_comments', [req.auth!.userId]));
  app.get('/comments/list', async (req) => {
    const { filter } = z
      .object({
        filter: z
          .enum(['open', 'review', 'approved', 'blocked', 'posted', 'rejected'])
          .default('open'),
      })
      .parse(req.query);
    return rpc(deps, 'ext_list_comments_filtered', [req.auth!.userId, filter]);
  });
  app.get('/activity', async (req) => rpc(deps, 'ext_activity', [req.auth!.userId, 100]));
  app.get('/campaigns', async (req) => rpc(deps, 'ext_list_campaigns', [req.auth!.userId]));
  app.get('/campaigns/:id', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(req.params);
    return rpc(deps, 'ext_campaign_detail', [req.auth!.userId, id]);
  });
  app.post('/campaigns/:id', async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/) }).parse(req.params);
    const { status } = z.object({ status: z.enum(['on', 'off']) }).parse(req.body);
    return rpc(deps, 'ext_set_campaign_status', [req.auth!.userId, id, status]);
  });

  // "Find comment ideas": posts read from the page Jibran has open. Posts already handled are skipped
  // before any AI call; drafts and skips are stored so the same post is never analysed twice.
  app.post(
    '/engagement/scan',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const userId = req.auth!.userId;
      const { posts } = EngagementScanRequest.parse(req.body);
      const keyed = posts.map((p) => ({ post: p, key: postKey(p) }));
      const known = new Set(
        await rpc<string[]>(deps, 'ext_engagement_known', [userId, keyed.map((k) => k.key)]),
      );
      const unseen = keyed.filter((k) => !known.has(k.key));
      // Sponsored posts are always skipped (engagement rules); decided in code, no AI call needed.
      const sponsored = unseen.filter((k) => k.post.promoted);
      const notAd = unseen.filter((k) => !k.post.promoted);
      // One comment per person per week: authors commented on lately (or with an open draft) are
      // skipped in code, before the AI sees the post.
      const paused = await rpc<PausedAuthor[]>(deps, 'ext_engagement_paused_authors', [
        userId,
        AUTHOR_PAUSE_DAYS,
      ]);
      const resting = notAd
        .map((k) => ({ ...k, by: pausedAuthor(k.post, paused) }))
        .filter((k) => k.by);
      const fresh = notAd.filter((k) => !resting.some((r) => r.key === k.key));
      const toItem = (post: (typeof keyed)[number]['post'], key: string) => ({
        post_key: key,
        post_urn: post.urn ?? '',
        post_url: post.url ?? (post.urn ? `https://www.linkedin.com/feed/update/${post.urn}/` : ''),
        post_excerpt: wellFormed(clip(post.text, 3000)),
        post_age: post.relativeDate,
        author_name: post.author,
        author_headline: post.authorHeadline,
        author_profile: post.authorProfile ?? '',
      });
      if (sponsored.length) {
        await rpc(deps, 'ext_save_engagement', [
          userId,
          JSON.stringify(
            sponsored.map((s) => ({
              ...toItem(s.post, s.key),
              comment: '',
              reason: 'sponsored post (always skipped)',
              marketing_level: 0,
              verdict: 'skip',
            })),
          ),
        ]);
      }
      if (resting.length) {
        await rpc(deps, 'ext_save_engagement', [
          userId,
          JSON.stringify(
            resting.map((r) => ({
              ...toItem(r.post, r.key),
              comment: '',
              reason:
                r.by!.status === 'posted'
                  ? `commented on ${r.post.author} on ${r.by!.at.slice(0, 10)}: pause of ${AUTHOR_PAUSE_DAYS} days`
                  : `a comment for ${r.post.author} is already open (${r.by!.status})`,
              marketing_level: 0,
              verdict: 'skip',
            })),
          ),
        ]);
      }
      const empty = {
        seen: posts.length,
        alreadyKnown: posts.length - unseen.length,
        drafted: 0,
        skipped: sponsored.length + resting.length,
        rejectedDrafts: 0,
        costUsd: 0,
      };
      if (!fresh.length) return EngagementScanResult.parse(empty);

      // Batches of 10 keep each answer well inside the output limit (a 19-post answer came back
      // empty). Each batch is saved as soon as it is done, so a later failure loses nothing.
      const banned = await bannedPhrases(deps, userId);
      // Grows with each batch, so a later batch does not repeat an earlier one.
      const earlier = await recentComments(deps, userId);
      const totals = {
        drafted: 0,
        skipped: sponsored.length + resting.length,
        rejectedDrafts: 0,
        costUsd: 0,
      };
      for (let i = 0; i < fresh.length; i += SCAN_BATCH) {
        const batch = fresh.slice(i, i + SCAN_BATCH);
        const task = await prepareEngagementPick(
          batch.map((f) => f.post),
          { db: deps.db, userId },
          banned,
          undefined,
          earlier,
        );
        const run = await runTask<EngagementItem[]>(deps, userId, 'engagement_pick', task);
        const items = run.output.map((it) => {
          const { post, key } = batch[it.index]!;
          return {
            ...toItem(post, key),
            comment: it.comment,
            reason: [it.reason, it.reach_note].filter(Boolean).join(' · '),
            marketing_level: it.marketing_level,
            verdict: it.verdict,
          };
        });
        await rpc(deps, 'ext_save_engagement', [userId, JSON.stringify(items)]);
        earlier.push(...items.filter((x) => x.verdict === 'draft').map((x) => x.comment));
        totals.drafted += items.filter((x) => x.verdict === 'draft').length;
        totals.skipped += items.filter((x) => x.verdict === 'skip').length;
        totals.rejectedDrafts += run.output.filter((x) =>
          x.reason.startsWith('draft failed checks'),
        ).length;
        totals.costUsd += run.costUsd;
      }
      return EngagementScanResult.parse({ ...empty, ...totals });
    },
  );

  app.post('/queue/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = QueueReview.parse(req.body);
    const userId = req.auth!.userId;
    if (body.decision === 'approve') {
      const errors = await queueApprovalErrors(deps, userId, id, body.text);
      if (errors.length)
        return reply.status(422).send({ error: errors.join('; '), code: 'bad_request', errors });
    }
    return rpc(deps, 'ext_review_queue', [userId, id, body.decision, body.text]);
  });

  app.post('/leads/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const body = LeadReview.parse(req.body);
    return rpc(deps, 'ext_review_lead', [
      req.auth!.userId,
      id,
      body.decision,
      body.campaignId,
      body.reason,
    ]);
  });

  // ---------- comment library: real comments read under posts, for study and as style references ----------
  app.post('/comment-library', async (req) =>
    addToCommentLibrary(deps, req.auth!.userId, req.body),
  );
  app.get('/comment-library', async (req) => {
    const q = z
      .object({
        filter: z.enum(['all', 'mine', 'others', 'good', 'bad', 'liked']).default('all'),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    return rpc(deps, 'ext_comment_samples_list', [req.auth!.userId, q.filter, q.limit]);
  });
  app.post('/comment-library/:id/label', async (req) => {
    const { id } = Id.parse(req.params);
    const b = z
      .object({
        label: z.enum(['good', 'bad']).nullable(),
        note: z.string().max(500).nullable().default(null),
      })
      .parse(req.body);
    return rpc(deps, 'ext_comment_sample_label', [req.auth!.userId, id, b.label, b.note]);
  });

  // ---------- comment study: collect, analyse, propose new DRAFTING rules (applied only on Jibran's click) ----------
  app.post('/comment-library/study-plan', async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(30).default(10) })
      .parse(req.body ?? {});
    return {
      posts: await rpc<string[]>(deps, 'ext_comment_study_plan', [req.auth!.userId, limit]),
    };
  });
  app.get('/comment-library/study', async (req) =>
    rpc(deps, 'ext_comment_study_latest', [req.auth!.userId]),
  );
  app.post(
    '/comment-library/analyze',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req) => {
      const userId = req.auth!.userId;
      const { posts: n } = z
        .object({ posts: z.coerce.number().int().min(5).max(60).default(30) })
        .parse(req.body ?? {});
      const posts = await rpc<StudyPost[]>(deps, 'ext_comment_study_input', [userId, n]);
      if (posts.length < 5)
        throw new HttpError(
          400,
          'bad_request',
          `Only ${posts.length} posts with 2+ comments in the library; collect at least 5 first.`,
        );
      const stats = studyStats(posts);
      const rules = (await rpc<{ body: string }>(deps, 'ext_get_doc', [userId, 'engagement_rules']))
        .body;
      const task = await prepareCommentStudy(posts, stats, rules, { db: deps.db, userId });
      // Two calls (14.11.2026): the labels per post are a nice-to-have; the findings and rules are not.
      const [run, labels] = await Promise.all([
        runTask<StudyResult>(deps, userId, 'comment_study', task),
        prepareCommentStudyPosts(posts, { db: deps.db, userId })
          .then((t) => runTask<StudyPostLabel[]>(deps, userId, 'comment_study_posts', t))
          .catch(() => null),
      ]);
      const postLabels = labels?.output.length ? labels.output : run.output.posts;
      const proposed = replaceDraftingSection(rules, run.output.drafting);
      if (!proposed)
        throw new HttpError(422, 'bad_request', 'The rules have no DRAFTING section to replace.');
      const comments = posts.reduce((a, p) => a + p.comments.length, 0);
      const findings = {
        ...run.output.findings,
        posts: postLabels.map((p) => ({
          ...p,
          url: posts[p.index]?.url ?? null,
          author: posts[p.index]?.author ?? null,
        })),
        cost_usd: run.costUsd + (labels?.costUsd ?? 0),
      };
      const saved = await rpc<{ id: number }>(deps, 'ext_comment_study_save', [
        userId,
        posts.length,
        comments,
        JSON.stringify(stats),
        JSON.stringify(findings),
        proposed,
        null,
      ]);
      return {
        id: saved.id,
        posts: posts.length,
        comments,
        costUsd: run.costUsd + (labels?.costUsd ?? 0),
      };
    },
  );
  app.post('/comment-library/study/:id/decide', async (req) => {
    const { id } = Id.parse(req.params);
    const { decision } = z.object({ decision: z.enum(['apply', 'dismiss']) }).parse(req.body);
    return rpc(deps, 'ext_comment_study_decide', [req.auth!.userId, id, decision]);
  });

  app.get('/comment-mode', async (req) => rpc(deps, 'ext_comment_mode', [req.auth!.userId]));
  app.post('/comment-mode', async (req) => {
    const { live } = z.object({ live: z.boolean() }).parse(req.body);
    return rpc(deps, 'ext_set_comment_live', [req.auth!.userId, live]);
  });

  // Before posting: the approved text is fact-checked (code + AI) against the post. Returns what the
  // extension needs to post, or 422 with the problems.
  app.post('/comments/:id/prepare', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const userId = req.auth!.userId;
    const target = CommentTarget.parse(await rpc(deps, 'ext_comment_target', [userId, id]));
    const post = target.post_excerpt ?? '';
    const issues = factCheckComment(target.text, post, await bannedPhrases(deps, userId));
    if (!issues.length) {
      const task = await prepareCommentFactcheck(
        {
          author: target.author_name ?? '',
          headline: target.author_headline ?? '',
          post,
          comment: target.text,
        },
        { db: deps.db, userId },
      );
      const run = await runTask<FactCheck>(deps, userId, 'comment_factcheck', task);
      if (run.output.verdict === 'block') issues.push(...run.output.issues);
    }
    if (issues.length) {
      // Out of "Approved" into "Blocked", with the reason; edit + approve brings it back.
      await rpc(deps, 'ext_comment_blocked', [userId, id, issues.join('; ')]);
      return reply.status(422).send({ error: issues.join('; '), code: 'bad_request', issues });
    }
    return { ...target, factCheck: 'ok' };
  });

  app.post('/comments/:id/result', async (req) => {
    const { id } = Id.parse(req.params);
    const result = CommentAttempt.parse(req.body);
    return rpc(deps, 'ext_comment_result', [req.auth!.userId, id, JSON.stringify(result)]);
  });

  app.post('/comments/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = CommentReview.parse(req.body);
    if (body.decision === 'approve' && body.text) {
      const blocking = await commentApprovalErrors(deps, req.auth!.userId, body.text);
      if (blocking.length)
        return reply
          .status(422)
          .send({ error: blocking.join('; '), code: 'bad_request', errors: blocking });
    }
    return rpc(deps, 'ext_review_comment', [req.auth!.userId, id, body.decision, body.text]);
  });

  // Local development only: stores a captured page sent by the side panel. Raw pages go to
  // DEV_CAPTURE_DIR (mounted to the git-ignored fixtures/raw), redacted ones to DEV_CAPTURE_REDACTED_DIR
  // (fixtures/redacted). On the server: a private volume (docker-compose.prod.yml), copied to the Mac with
  // scripts/pull-captures.sh. Disabled when DEV_CAPTURE_DIR is not set.
  app.post('/dev/capture', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const dir = process.env.DEV_CAPTURE_DIR;
    if (!dir) throw new HttpError(404, 'not_found', 'capture is only available on a local server');
    const body = z
      .object({
        kind: z.string().regex(/^[a-z-]{2,30}$/),
        lang: z.string().regex(/^[a-z]{2,7}$/),
        html: z.string().max(8_000_000),
      })
      .parse(req.body);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folder = join(dir, body.kind);
    await mkdir(folder, { recursive: true });
    const name = `linkedin-raw-${body.kind}-${body.lang}-${stamp}.html`;
    await writeFile(join(folder, name), body.html, 'utf8');
    return {
      ok: true,
      file: `fixtures/raw/${body.kind}/${name}`,
      kb: Math.round(body.html.length / 1024),
    };
  });
};
