// @vitest-environment happy-dom
// Runs only where the local, git-ignored raw captures exist (Jibran's Mac).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseConnectedOn,
  parseSentAgo,
  readConnections,
  readInbox,
  readSentInvitations,
} from '../src/lib/adapters/sync.ts';

const raw = resolve(import.meta.dirname, '../../fixtures/raw');
const pages = (kind: string) => {
  const d = join(raw, kind);
  return existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.html'))
        .map((f) => join(d, f))
    : [];
};
const load = (f: string) => (document.documentElement.innerHTML = readFileSync(f, 'utf8'));

describe('sync parsers', () => {
  it('dates', () => {
    expect(parseConnectedOn('Connected on October 8, 2026')).toBe('2026-10-08');
    expect(parseSentAgo('Sent 5 days ago')).toBe(5);
    expect(parseSentAgo('Sent 2 weeks ago')).toBe(14);
    expect(parseSentAgo('Sent 1 month ago')).toBe(30);
    expect(parseSentAgo('Sent today')).toBe(0);
  });
});

describe.skipIf(!pages('connections').length)('connections page', () => {
  it.each(pages('connections'))('%s', (f) => {
    load(f);
    const { total, items } = readConnections(document);
    expect(total).toBeGreaterThan(100);
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const c of items) {
      expect(c.profileUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/);
      expect(c.connectedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.profileUrn).toMatch(/^urn:li:fsd_profile:/);
      expect(c.name).not.toMatch(/Connected on|Message/);
    }
  });
});

describe.skipIf(!pages('sent-invitations').length)('sent invitations page', () => {
  it.each(pages('sent-invitations'))('%s', (f) => {
    load(f);
    const { total, items } = readSentInvitations(document);
    expect(total).toBeGreaterThan(10);
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const s of items) {
      expect(s.profileUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/);
      expect(s.sentDaysAgo).not.toBeNull();
      expect(s.headline ?? '').not.toMatch(/^Sent /);
    }
  });
});

describe.skipIf(!pages('messaging').length)('inbox list', () => {
  it.each(pages('messaging'))('%s', (f) => {
    load(f);
    const items = readInbox(document);
    expect(items.length).toBeGreaterThanOrEqual(8);
    for (const i of items) {
      expect(i.name.length).toBeGreaterThan(1);
      expect(i.snippet).not.toMatch(/^You:/);
      if (!i.sponsored) expect(i.snippet.startsWith(`${i.name.split(' ')[0]}:`)).toBe(false);
    }
    expect(items.some((i) => i.fromMe)).toBe(true);
  });
});
