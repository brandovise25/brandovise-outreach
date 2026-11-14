// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { readSentInvitations } from '../src/lib/adapters/sync.ts';

// Since about 02.11.2026 the Sent invitations page shows "People 331" on the People tab instead of
// "People (328)". Without the total the robot stops inviting after 2 days (pending_unknown).
const item = (name: string, slug: string) => `
  <div role="listitem"><a href="https://www.linkedin.com/in/${slug}/">${name}</a>
    <p>Inhaberin Maklerbüro</p><p>Sent 3 days ago</p>
    <a aria-label="Withdraw invitation sent to ${name}" href="#">Withdraw</a></div>`;

describe('sent invitations total', () => {
  it('reads "People 331" from the People tab', () => {
    document.body.innerHTML = `<nav><ul><li>
      <a aria-current="true" href="https://www.linkedin.com/mynetwork/invitation-manager/sent/CONNECTION/"><span>People 331</span></a>
      </li></ul></nav>${item('Anna Muster', 'anna-muster')}${item('Bernd Beispiel', 'bernd-beispiel')}`;
    const r = readSentInvitations(document);
    expect(r.total).toBe(331);
    expect(r.items.map((i) => i.name)).toEqual(['Anna Muster', 'Bernd Beispiel']);
    expect(r.items[0]!.sentDaysAgo).toBe(3);
  });

  it('still reads the older "People (328)" and a thousands separator', () => {
    document.body.innerHTML = `<h2>People (1,328)</h2>${item('Anna Muster', 'anna-muster')}`;
    expect(readSentInvitations(document).total).toBe(1328);
  });

  it('gives no total when the page shows none', () => {
    document.body.innerHTML = item('Anna Muster', 'anna-muster');
    expect(readSentInvitations(document).total).toBeNull();
  });
});
