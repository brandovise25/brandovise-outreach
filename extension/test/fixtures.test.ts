import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Safety net before fixtures are committed: no embedded data, no media URLs, no real profile slugs.
// fileURLToPath, not .pathname: the project path contains a space, which .pathname leaves as %20.
const ROOT = fileURLToPath(new URL('../../fixtures/redacted', import.meta.url));

function files(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.html') ? [p] : [];
    });
  } catch {
    return [];
  }
}

describe('redacted fixtures', () => {
  const all = files(ROOT);
  it('finds the fixture folder', () => {
    expect(() => readdirSync(ROOT)).not.toThrow();
  });
  it.each(all.length ? all : ['(none yet)'])('%s is redacted', (file) => {
    if (file === '(none yet)') return;
    const html = readFileSync(file, 'utf8');
    expect(html).not.toMatch(/<script|<code|<style/i);
    expect(html).not.toMatch(/licdn\.com|media\.licdn/);
    const slugs = [...html.matchAll(/linkedin\.com\/in\/([^/"?#]+)/g)].map((m) => m[1]);
    expect(slugs.every((s) => /^person-\d+$/.test(s!))).toBe(true);
    // ids must not carry member URNs or slug-like "<first>-<last>-<digits>" tokens
    const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
    expect(ids.filter((i) => /ACoAA|[a-z]+-[a-z]+-\d{5,}/i.test(i))).toEqual([]);
  });
});
