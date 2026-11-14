// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw captures exist (Jibran's Mac).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageOwner, readOwnComments } from '../src/lib/adapters/own-comments.ts';

const dir = resolve(import.meta.dirname, '../../fixtures/raw/activity');
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.html'))
      .map((f) => join(dir, f))
      .filter((f) => /ProfileRecentActivityComments/.test(readFileSync(f, 'utf8')))
  : [];

describe.skipIf(!files.length)("a person's own comments", () => {
  it.each(files)('%s', (f) => {
    document.documentElement.innerHTML = readFileSync(f, 'utf8');
    expect(pageOwner(document)).toBeTruthy();
    const cs = readOwnComments(document);
    expect(cs.length).toBeGreaterThanOrEqual(5);
    for (const c of cs) {
      expect(c.text.length).toBeGreaterThan(10);
      if (c.on) expect(c.on).not.toBe(c.text.slice(0, 300));
    }
    // most comments come with the post they answer
    expect(cs.filter((c) => c.on).length).toBeGreaterThanOrEqual(Math.ceil(cs.length * 0.8));
  });
});
