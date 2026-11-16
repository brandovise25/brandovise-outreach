// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReceivedInvitations } from '../src/lib/adapters/sync.ts';

// Invitations received (16.11.2026). The rows follow a page saved by the robot that day; names invented.
const row = (inner: string, id = '7528016694632448054') =>
  `<div componentkey="invitation_manager_row_urn:li:invitation:${id}"><div data-display-contents="true">
   <div role="listitem" componentkey="urn:li:invitation:${id}" aria-label="">${inner}</div></div></div>`;

const event = row(`<div><p><span>Event • Tue, Dec 8, 11:00 AM</span></p>
  <p><a aria-label="View Erika Beispiel’s profile" href="https://www.linkedin.com/in/erika-beispiel/"><strong>Erika Beispiel</strong></a>
  <span> </span>invited you to attend <a href="https://www.linkedin.com/events/1/"><strong>Ein Webinar</strong></a></p></div>
  <button type="button" aria-label="Ignore invitation for Ein Webinar"><span>Ignore</span></button>
  <a href="https://www.linkedin.com/events/1/" aria-label="Accept invitation for Ein Webinar"><span>Accept</span></a>`);

const request = (slug: string, name: string, id: string) =>
  row(
    `<div><p><a aria-label="View ${name}’s profile" href="https://www.linkedin.com/in/${slug}/?miniProfileUrn=x"><strong>${name}</strong></a></p>
     <p>Inhaber · KI-Automatisierung für Handwerksbetriebe</p><p>12 mutual connections</p></div>
     <button type="button" aria-label="Ignore an invitation to connect from ${name}"><span>Ignore</span></button>
     <button type="button" aria-label="Accept ${name}’s invitation"><span>Accept</span></button>`,
    id,
  );

function page(rows: string) {
  document.body.innerHTML = `<main><h2>Received</h2><div data-testid="lazy-column">${rows}</div></main>`;
  return document;
}

describe('readReceivedInvitations', () => {
  it('returns connection requests and only counts event invitations', () => {
    const r = readReceivedInvitations(
      page(
        event +
          request('max-muster-ki', 'Max Muster', '1') +
          request('max-muster-ki', 'Max Muster', '2'),
      ),
    );
    expect(r.items).toEqual([
      { name: 'Max Muster', profileUrl: 'https://www.linkedin.com/in/max-muster-ki/' },
    ]);
    expect(r.other).toBe(1);
  });

  it('skips a row without an Accept control', () => {
    const noAccept = row(
      `<p><a aria-label="View Max Muster’s profile" href="https://www.linkedin.com/in/max-muster-ki/">Max Muster</a></p>`,
      '3',
    );
    expect(readReceivedInvitations(page(noAccept)).items).toEqual([]);
  });

  // The page as the robot saved it (only on the maintainer's machine, never committed).
  const dir = resolve(import.meta.dirname, '../../fixtures/raw/other');
  const saved = existsSync(dir)
    ? readdirSync(dir).filter((f) => {
        const h = readFileSync(join(dir, f), 'utf8');
        return h.includes('invitation-manager/received/ALL') && h.includes('urn:li:invitation:');
      })
    : [];
  it.skipIf(!saved.length)('on the saved page, the event invitation is not a request', () => {
    document.documentElement.innerHTML = readFileSync(join(dir, saved[0]!), 'utf8')
      .replace(/^<!doctype html>\s*/i, '')
      .replace(/^<html[^>]*>|<\/html>$/g, '');
    const r = readReceivedInvitations(document);
    expect(r.items).toEqual([]);
    expect(r.other).toBeGreaterThan(0);
  });
});
