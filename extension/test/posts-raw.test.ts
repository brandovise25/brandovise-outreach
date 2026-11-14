// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw feed captures exist (Jibran's Mac).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPosts } from '../src/lib/adapters/posts.ts';

const dir = resolve(import.meta.dirname, '../../fixtures/raw/feed');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : [];

describe.skipIf(!files.length)('readPosts on raw feed captures', () => {
  it.each(files)('%s: the author is the post author, never the "likes this" person', (file) => {
    document.documentElement.innerHTML = readFileSync(join(dir, file), 'utf8').replace(
      /^<!doctype html>\s*/i,
      '',
    );
    const posts = readPosts(document);
    expect(posts.length).toBeGreaterThan(0);
    const named = Array.from(
      document.querySelectorAll('button[aria-label^="Open control menu for post by"]'),
    ).map((b) => b.getAttribute('aria-label')!.replace('Open control menu for post by ', ''));
    for (const p of posts) {
      if (named.length) expect(named).toContain(p.author);
      expect(p.authorHeadline ?? '').not.toMatch(
        /likes this|commented|reposted this|celebrates this/,
      );
    }
  });
});
