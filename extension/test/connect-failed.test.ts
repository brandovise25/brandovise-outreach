// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithNote, takeSnapshot } from '../src/lib/adapters/send.ts';

// Invite dialog that never opens (31.10.2026: every live invite failed with this): the page as LinkedIn
// showed it must be kept, so the cause can be read from real HTML.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connectWithNote when the dialog does not open', () => {
  it('fails at the dialog step and keeps a snapshot of the page', async () => {
    document.body.innerHTML = `<main><section>
      <h1>Anna Muster</h1>
      <a aria-label="Invite Anna Muster to connect" href="/preload/custom-invite/?vanityName=anna-muster"><span>Connect</span></a>
      <a href="/messaging/compose/?recipient=x"><span>Message</span></a>
      <div id="toast">Something went wrong</div>
    </section></main>`;
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r).toMatchObject({ ok: false, step: 'dialog', note: 'The invite dialog did not open.' });
    const html = takeSnapshot();
    expect(html).toMatch(/Something went wrong/);
    expect(takeSnapshot()).toBeNull(); // handed out once
  });

  it('keeps the dialog when it opens without an "Add a note" button', async () => {
    document.body.innerHTML = `<main><section>
      <h1>Anna Muster</h1>
      <a id="c" aria-label="Invite Anna Muster to connect" href="/preload/custom-invite/?vanityName=anna-muster"><span>Connect</span></a>
      <a href="/messaging/compose/?recipient=x"><span>Message</span></a>
    </section></main>`;
    document.getElementById('c')!.addEventListener('click', (e) => {
      e.preventDefault();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div role="dialog"><p>Personalised invitation limit reached</p><button>Send without a note</button><button aria-label="Dismiss">x</button></div>',
      );
    });
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r).toMatchObject({ ok: false, step: 'dialog' });
    expect(r.note).toMatch(/No "Add a note" button/);
    expect(takeSnapshot()).toMatch(/Personalised invitation limit reached/);
  });
});
