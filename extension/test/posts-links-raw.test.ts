// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw captures exist (Jibran's Mac): every post read from a
// feed or activity page must carry its own link (decoded from the card key).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPosts } from '../src/lib/adapters/posts.ts';

const root = resolve(import.meta.dirname, '../../fixtures/raw');
const files = ['feed', 'activity']
  .map((d) => join(root, d))
  .filter(existsSync)
  .flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.html'))
      .map((f) => join(d, f)),
  );

describe.skipIf(!files.length)('post links on raw captures', () => {
  it.each(files)('%s', (file) => {
    document.documentElement.innerHTML = readFileSync(file, 'utf8').replace(
      /^<!doctype html>\s*/i,
      '',
    );
    const posts = readPosts(document);
    const withLink = posts.filter((p) => /urn:li:(activity|ugcPost):\d+/.test(p.url ?? ''));
    console.warn(
      file.split('/').slice(-2).join('/'),
      `${withLink.length}/${posts.length} with link`,
    );
    // A few cards carry no id at all; posting then finds them on the author's page.
    expect(withLink.length).toBeGreaterThanOrEqual(Math.ceil(posts.length * 0.8));
  });

  it.each(files)('%s: a comment under a post is never read as a post', (file) => {
    document.documentElement.innerHTML = readFileSync(file, 'utf8').replace(
      /^<!doctype html>\s*/i,
      '',
    );
    const comments = Array.from(
      document.querySelectorAll('[componentkey^="CommentComponentReference"]'),
    ).map((c) => (c.textContent ?? '').replace(/\s+/g, ' '));
    for (const p of readPosts(document)) {
      const start = p.text.replace(/\s+/g, ' ').slice(0, 60);
      const ownText = Array.from(document.querySelectorAll('[data-testid="expandable-text-box"]'))
        .filter((e) => !e.closest('[componentkey^="CommentComponentReference"]'))
        .some((e) => (e.textContent ?? '').replace(/\s+/g, ' ').includes(start));
      // the text is a post's own text, or at least not only found inside a comment
      if (!ownText) expect(comments.some((c) => c.includes(start))).toBe(false);
    }
  });
});
