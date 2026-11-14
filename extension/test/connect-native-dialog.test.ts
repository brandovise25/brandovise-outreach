// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithNote } from '../src/lib/adapters/send.ts';

// 13.11.2026: every live invite failed with 'No "Add a note" button'. The failure snapshots showed the
// new dialog: a native <dialog data-testid="dialog" open> at the top of the page, with "Add a note" as a
// link. A minimised messaging bubble (role="dialog", aria-label "Messaging") sat in the shadow layer and
// was mistaken for the invite dialog. The structure below follows those snapshots (names invented).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function profile(delayMs: number, fillMs = 0, send: 'on' | 'late' | 'never' = 'on') {
  document.body.innerHTML = `<div id="root"></div><main><section>
    <h1>Anna Muster</h1>
    <a aria-label="Invite Anna Muster to connect" href="https://www.linkedin.com/in/anna-muster/"><span>Connect</span></a>
  </section></main>
  <div id="interop-outlet" data-testid="interop-shadowdom"></div>`;
  const shadow = document.getElementById('interop-outlet')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<div role="dialog" aria-label="Messaging" class="msg-overlay-conversation-bubble"
    data-view-name="message-overlay-conversation-bubble-item"><button>Not interested</button></div>`;
  const root = document.getElementById('root')!;
  document.querySelector('a[aria-label^="Invite "]')!.addEventListener('click', (e) => {
    e.preventDefault();
    // 14.11.2026: the dialog may open empty and be replaced by a filled one a few seconds later.
    if (fillMs)
      setTimeout(
        () =>
          (root.innerHTML = `<dialog data-testid="dialog" open=""><div data-testid="dialog-content"></div></dialog>`),
        delayMs - fillMs,
      );
    setTimeout(() => {
      root.innerHTML = `<dialog data-testid="dialog" aria-labelledby="dialog-header" open="">
        <button type="button" aria-label="Dismiss"></button>
        <div data-testid="dialog-content"><p>Add a note to your invitation?</p>
          <a aria-disabled="false" href="https://www.linkedin.com/in/anna-muster/"><span><span>Add a note</span></span></a>
          <button type="button"><span><span>Send without a note</span></span></button>
        </div></dialog>`;
      const d = root.querySelector('dialog')!;
      d.querySelector('[aria-label="Dismiss"]')!.addEventListener(
        'click',
        () => (root.innerHTML = ''),
      );
      d.querySelector('a')!.addEventListener('click', (ev) => {
        ev.preventDefault();
        d.querySelector('[data-testid="dialog-content"]')!.innerHTML =
          `<textarea name="message"></textarea><p>219/200</p>
          <button type="button"><span>Cancel</span></button><button type="button"${send === 'on' ? '' : ' disabled'}><span>Send</span></button>`;
        if (send === 'late')
          setTimeout(() => d.querySelector('button[disabled]')?.removeAttribute('disabled'), 5000);
      });
    }, delayMs);
  });
  return { root, shadow };
}

describe('connectWithNote with the native dialog (13.11.2026)', () => {
  it('ignores the chat bubble, follows the "Add a note" link, types the note and finds Send', async () => {
    const { root, shadow } = profile(2500);
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: true, step: 'typed', finalButton: 'Send' });
    expect(root.querySelector('dialog')).toBeNull(); // closed again, nothing sent
    expect(shadow.querySelector('[aria-label="Messaging"]')).not.toBeNull(); // the chat was not touched
  });

  it('waits when the dialog opens empty and is filled a few seconds later (14.11.2026)', async () => {
    const { root } = profile(6000, 4000);
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: true, step: 'typed', finalButton: 'Send' });
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('waits for Send to become enabled after typing (14.11.2026)', async () => {
    profile(2500, 0, 'late');
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: true, finalButton: 'Send' });
  });

  it('says that Send stayed disabled and what the dialog shows', async () => {
    profile(2500, 0, 'never');
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(40_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Send button stayed disabled \(dialog: "219\/200"\)/);
  });

  it('reports that no dialog opened when only the chat bubble is there', async () => {
    profile(60_000);
    const p = connectWithNote('Guten Tag Anna, hallo.', true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toMatchObject({ ok: false, note: 'The invite dialog did not open.' });
  });
});
