// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw captures exist (Jibran's Mac).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readExperienceDetails, readProfileTop } from '../src/lib/adapters/profile.ts';

const raw = resolve(import.meta.dirname, '../../fixtures/raw');
const list = (kind: string, screen: RegExp) => {
  const d = join(raw, kind);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(d, f))
    .filter((f) => screen.test(readFileSync(f, 'utf8').slice(0, 400_000)));
};
const profiles = [...list('profile', /data-sdui-screen="[^"]*profile\.Profile"/)];
const experience = [
  ...list('other', /ProfileExperienceDetails/),
  ...list('profile', /ProfileExperienceDetails/),
];
const load = (f: string) => (document.documentElement.innerHTML = readFileSync(f, 'utf8'));

describe.skipIf(!profiles.length)('profile top card', () => {
  it.each(profiles)('%s', (f) => {
    load(f);
    const p = readProfileTop(document)!;
    expect(p).not.toBeNull();
    expect(p.name.length).toBeGreaterThan(2);
    expect(p.headline ?? '').not.toMatch(/^(Message|Connect|Follow|·)/);
    expect(p.location).toBeTruthy();
    expect(p.actions.connect || p.actions.message || p.actions.follow || p.actions.pending).toBe(
      true,
    );
  });
});

describe.skipIf(!experience.length)('experience details', () => {
  it.each(experience)('%s', (f) => {
    load(f);
    const items = readExperienceDetails(document);
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) {
      expect(e.title.length).toBeGreaterThan(2);
      expect(e.dates).toMatch(/\d{4}/);
    }
  });
});
