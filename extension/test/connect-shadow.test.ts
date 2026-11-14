// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithNote, takeSnapshot } from '../src/lib/adapters/send.ts';

// Since about 29.10.2026 LinkedIn opens the invite dialog inside the shadow root of #interop-outlet
// (seen in the failure snapshots of 02.11.2026: the outlet was visible but empty in the page HTML).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function profileWithShadowDialog() {
  document.body.innerHTML = `<main><section>
    <h1>Anna Muster</h1>
    <a aria-label="Invite Anna Muster to connect" href="/preload/custom-invite/?vanityName=anna-muster"><span>Connect</span></a>
  </section></main>
  <div id="interop-outlet" data-testid="interop-shadowdom"></div>`;
  const root = document.getElementById('interop-outlet')!.attachShadow({ mode: 'open' });
  const link = document.querySelector<HTMLAnchorElement>('a[aria-label^="Invite "]')!;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    root.innerHTML = `<div role="dialog"><h2>Add a note to your invitation?</h2>
      <button aria-label="Dismiss">x</button>
      <button>Add a note</button><button>Send without a note</button></div>`;
    root
      .querySelector<HTMLButtonElement>('button:nth-of-type(2)')!
      .addEventListener('click', () => {
        root.querySelector('[role="dialog"]')!.innerHTML = `<textarea name="message"></textarea>
        <button aria-label="Dismiss">x</button><button>Cancel</button><button>Send</button>`;
        root
          .querySelector('[role="dialog"]')!
          .querySelector('[aria-label="Dismiss"]')!
          .addEventListener('click', () => (root.innerHTML = ''));
      });
  });
  return root;
}

describe('connectWithNote with the dialog in the shadow layer', () => {
  it('finds the dialog, types the note and finds Send (practice)', async () => {
    const root = profileWithShadowDialog();
    const p = connectWithNote('Guten Tag Anna, hallo.', true, true);
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true, step: 'typed', finalButton: 'Send' });
    expect(root.querySelector('[role="dialog"]')).toBeNull(); // closed again, nothing sent
    expect(takeSnapshot()).toMatch(/interop-outlet shadow root[\s\S]*<textarea/);
  });
});
