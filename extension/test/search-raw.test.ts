// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw captures exist (Jibran's Mac).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSearchResults } from '../src/lib/adapters/search.ts';

const dir = resolve(import.meta.dirname, '../../fixtures/raw/search-people');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : [];

describe.skipIf(!files.length)('people search results on raw captures', () => {
  it.each(files)('%s', (file) => {
    document.documentElement.innerHTML = readFileSync(join(dir, file), 'utf8');
    const { people, hasNext } = readSearchResults(document);
    expect(people.length).toBeGreaterThanOrEqual(8);
    expect(hasNext).toBe(true);
    for (const p of people) {
      expect(p.profileUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\/[^/?]+\/$/);
      expect(p.name.length).toBeGreaterThan(2);
      expect(p.name).not.toMatch(/•|2nd|Connect/);
      expect(p.headline ?? '').not.toMatch(/^(Connect|Message|Follow)$/);
    }
    // most results show a headline and a location; connect/pending states are recognised
    expect(people.filter((p) => p.headline).length).toBeGreaterThanOrEqual(people.length - 1);
    expect(people.some((p) => p.action === 'connect')).toBe(true);
    expect(people.filter((p) => p.degree).length).toBeGreaterThanOrEqual(people.length - 2);
    expect(people.filter((p) => p.location).length).toBeGreaterThanOrEqual(people.length - 2);
  });
});
