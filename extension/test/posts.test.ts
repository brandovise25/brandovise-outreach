// @vitest-environment happy-dom
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FeedPost } from '@outreach/shared';
import { readPosts } from '../src/lib/adapters/posts.ts';

const dir = resolve(import.meta.dirname, '../../fixtures/redacted/profile/en');
// The saved LinkedIn pages are not part of the public copy; then these tests are skipped.
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : [];

function load(file: string): Document {
  const html = readFileSync(join(dir, file), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/^<!doctype html>\s*/i, '')
    .replace(/^<html[^>]*>|<\/html>$/g, '');
  return document;
}

describe.skipIf(!files.length)('readPosts on captured profile pages (activity posts)', () => {
  it.each(files)('%s', (file) => {
    const posts = readPosts(load(file));
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(FeedPost.safeParse(p).success).toBe(true);
      expect(p.text.length).toBeGreaterThan(20);
      expect(p.author.length).toBeGreaterThan(1);
    }
    // one post per reactions-menu button, each with a permalink, and no badge taken for a headline
    const buttons = document.querySelectorAll('button[aria-label="Open reactions menu"]').length;
    // Captures from before 09.10.2026 gave every post the same fake id and identical "xxxx" text,
    // so a repost and its original (or two similar posts) can collapse into one there.
    expect(posts.length).toBeGreaterThanOrEqual(Math.ceil(buttons * 0.7));
    expect(posts.length).toBeLessThanOrEqual(buttons);
    expect(posts.every((p) => p.urn?.startsWith('urn:li:'))).toBe(true);
    expect(posts.every((p) => !/^[•·]\s*\d/.test(p.authorHeadline ?? ''))).toBe(true);
  });
});

describe('cleanAuthor', async () => {
  const { cleanAuthor } = await import('../src/lib/adapters/posts.ts');
  it('removes badges, connection degree and decoration', () => {
    expect(cleanAuthor('Rena Gerlach Verified Profile 1st')).toBe('Rena Gerlach');
    expect(cleanAuthor('🪪 Gerd Ebner')).toBe('Gerd Ebner');
    expect(cleanAuthor('Fahad Maqbool • 2nd')).toBe('Fahad Maqbool');
    expect(cleanAuthor('Dr. Anna Wagner')).toBe('Dr. Anna Wagner');
  });
});
