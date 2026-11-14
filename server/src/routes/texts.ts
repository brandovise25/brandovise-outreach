import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { KeywordSet } from '@outreach/shared';
import { requireAuth, type AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { HttpError } from '../errors.ts';

// Settings → Prompts & rules: Jibran edits his rule texts (docs) and the AI prompts. Each save is a new
// version (old ones stay; prompts can go back one version). A prompt template must keep exactly the same
// {{placeholders}}, because the server fills them in (page text stays fenced in <page_data>).

const placeholders = (t: string) => [...new Set(t.match(/\{\{\w+\}\}/g) ?? [])].sort();

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

export const textsRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (req) => {
    await requireAuth(deps, req);
  });
  app.get('/texts', async (req) => rpc(deps, 'ext_editable_texts', [req.auth!.userId]));
  app.post('/texts/doc/:key', async (req) => {
    const { key } = z.object({ key: z.string().max(60) }).parse(req.params);
    const { content } = z.object({ content: z.string().min(20).max(40_000) }).parse(req.body);
    return rpc(deps, 'ext_doc_save', [req.auth!.userId, key, content, null]);
  });
  app.post('/texts/prompt/:task', async (req) => {
    const { task } = z.object({ task: z.string().max(60) }).parse(req.params);
    const body = z
      .object({
        system_prompt: z.string().min(50).max(30_000),
        user_template: z.string().min(10).max(10_000),
      })
      .parse(req.body);
    const cur = await rpc<{ prompts: { task: string; user_template: string }[] }>(
      deps,
      'ext_editable_texts',
      [req.auth!.userId],
    );
    const active = cur.prompts.find((p) => p.task === task);
    if (!active) throw new HttpError(404, 'not_found', `unknown prompt ${task}`);
    const want = placeholders(active.user_template);
    const got = placeholders(body.user_template);
    if (want.join() !== got.join())
      throw new HttpError(
        400,
        'bad_request',
        `the template must keep exactly these placeholders: ${want.join(' ')} (found: ${got.join(' ') || 'none'})`,
      );
    if (want.includes('{{posts}}') || want.includes('{{samples}}') || want.includes('{{post}}')) {
      if (
        !/<page_data>[\s\S]*\{\{(posts|samples|post)\}\}[\s\S]*<\/page_data>/.test(
          body.user_template,
        )
      )
        throw new HttpError(
          400,
          'bad_request',
          'LinkedIn text must stay inside <page_data> … </page_data>',
        );
    }
    return rpc(deps, 'ext_prompt_save', [
      req.auth!.userId,
      task,
      body.system_prompt,
      body.user_template,
    ]);
  });
  // Prospecting keywords, edited per campaign in the Campaigns tab (stored as the prospecting_keywords text).
  app.get('/keywords', async (req) => {
    const t = await rpc<{ docs: { key: string; content: string }[] }>(deps, 'ext_editable_texts', [
      req.auth!.userId,
    ]);
    const raw = t.docs.find((d) => d.key === 'prospecting_keywords')?.content ?? '[]';
    const keywords = (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return [];
      }
    })();
    return {
      keywords: z.array(KeywordSet).catch([]).parse(keywords),
      stats: await rpc(deps, 'ext_keyword_stats', [req.auth!.userId]),
    };
  });
  app.post('/keywords', async (req) => {
    const { keywords } = z.object({ keywords: z.array(KeywordSet).max(100) }).parse(req.body);
    const seen = new Set<string>();
    for (const k of keywords) {
      const key = k.keyword.trim().toLowerCase();
      if (seen.has(key)) throw new HttpError(400, 'bad_request', `"${k.keyword}" is listed twice`);
      seen.add(key);
    }
    const clean = keywords.map((k) => ({ ...k, keyword: k.keyword.trim() }));
    return rpc(deps, 'ext_doc_save', [
      req.auth!.userId,
      'prospecting_keywords',
      JSON.stringify(clean, null, 2),
      'edited in the Campaigns tab',
    ]);
  });

  app.post('/texts/prompt/:task/revert', async (req) => {
    const { task } = z.object({ task: z.string().max(60) }).parse(req.params);
    return rpc(deps, 'ext_prompt_revert', [req.auth!.userId, task]);
  });
};
