// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithNote } from '../src/lib/adapters/send.ts';

// 14.11.2026: after "Add a note" the note box is a rich-text editor (div[contenteditable][role=textbox],
// TipTap) instead of a <textarea>; Send stays disabled until there is text. Every live invite failed
// with "The note box did not appear". Structure follows the failure snapshot (names invented).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function profile(typo = '') {
  document.body.innerHTML = `<div id="root"></div><main><section>
    <h1>Anna Muster</h1>
    <a aria-label="Invite Anna Muster to connect" href="https://www.linkedin.com/in/anna-muster/"><span>Connect</span></a>
  </section></main>`;
  const root = document.getElementById('root')!;
  document.querySelector('a[aria-label^="Invite "]')!.addEventListener('click', (e) => {
    e.preventDefault();
    root.innerHTML = `<dialog data-testid="dialog" open="">
      <button type="button" aria-label="Dismiss"></button>
      <div data-testid="dialog-content"><p>Add a note to your invitation?</p>
        <a href="https://www.linkedin.com/in/anna-muster/"><span><span>Add a note</span></span></a>
        <button type="button"><span><span>Send without a note</span></span></button>
      </div></dialog>`;
    const d = root.querySelector('dialog')!;
    d.querySelector('[aria-label="Dismiss"]')!.addEventListener(
      'click',
      () => (root.innerHTML = ''),
    );
    d.querySelector('a')!.addEventListener('click', (ev) => {
      ev.preventDefault();
      const content = d.querySelector('[data-testid="dialog-content"]')!;
      content.innerHTML = `<p>Add a note to your invitation</p>
        <div data-testid="ui-core-tiptap-text-editor-wrapper"><div contenteditable="true" role="textbox"><p data-placeholder="Ex: We know each other from..."><br></p></div></div>
        <button type="button"><span><span>Cancel</span></span></button>
        <button disabled type="button"><span data-appearance-state="disabled"><span>Send</span></span></button>`;
      const ed = content.querySelector<HTMLElement>('[contenteditable]')!;
      let cur = ed.querySelector('p')!;
      // happy-dom has no execCommand; like the browser, Send is enabled once there is text
      document.execCommand = (cmd: string, _ui?: boolean, v?: string) => {
        if (cmd === 'insertText') {
          if (cur.querySelector('br')) cur.innerHTML = '';
          cur.textContent = (cur.textContent ?? '') + typo + (v ?? '');
        }
        if (cmd === 'insertParagraph') cur = ed.appendChild(document.createElement('p'));
        content.querySelector('button[disabled]')?.removeAttribute('disabled');
        return true;
      };
    });
  });
  return root;
}

describe('connectWithNote with the rich-text note box (14.11.2026)', () => {
  it('types the note, checks it and finds Send (practice)', async () => {
    const root = profile();
    const p = connectWithNote('Guten Tag Anna,\n\nich baue KI-Agenten für Maklerbüros.', true);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: true, step: 'typed', finalButton: 'Send' });
    expect(root.querySelector('dialog')).toBeNull(); // closed again, nothing sent
  });

  it('sends nothing when the box holds something else', async () => {
    profile('x');
    const p = connectWithNote('Guten Tag Anna,\n\nhallo.', false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await p).toMatchObject({ ok: false, step: 'note' });
  });
});

describe('connectWithNote when an invitation is already pending', () => {
  it('counts it as done and opens nothing', async () => {
    document.body.innerHTML = `<main><section><h1>Anna Muster</h1>
      <button aria-label="Pending, click to withdraw invitation sent to Anna Muster">Pending</button></section></main>`;
    const p = connectWithNote('Guten Tag Anna, hallo.', false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ ok: true, step: 'already_pending' });
  });
});
