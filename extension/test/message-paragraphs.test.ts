// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/lib/adapters/send.ts';

// LinkedIn's message box keeps one <p> per paragraph; textContent joins them without a space.
// 29.10.2026 a two-paragraph message failed with "does not hold the approved text".
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function messageBox(typo = '') {
  document.body.innerHTML = `<form>
    <div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…"><p><br></p></div>
    <button class="msg-form__send-button" type="submit">Send</button>
  </form>`;
  const ed = document.querySelector<HTMLElement>('.msg-form__contenteditable')!;
  // Mimics the browser: insertText fills the current <p>, insertParagraph starts a new one,
  // selectAll + delete empties the box.
  let cur = ed.querySelector('p')!;
  // happy-dom has no execCommand.
  document.execCommand = (cmd: string, _ui?: boolean, v?: string) => {
    if (cmd === 'insertText') cur.textContent = (cur.textContent ?? '') + typo + (v ?? '');
    if (cmd === 'insertParagraph') cur = ed.appendChild(document.createElement('p'));
    if (cmd === 'delete') {
      ed.innerHTML = '<p><br></p>';
      cur = ed.querySelector('p')!;
    }
    return true;
  };
  return ed;
}

describe('sendMessage with several paragraphs', () => {
  it('accepts the typed text and finds Send (practice)', async () => {
    messageBox();
    const p = sendMessage('Hallo Kerstin,\n\ndanke für die Annahme.\n\nViele Grüße', true);
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true, step: 'typed', finalButton: 'Send' });
  });

  it('still refuses text that differs', async () => {
    const ed = messageBox('x');
    const p = sendMessage('Hallo Kerstin,\n\ndanke.', true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await p).toMatchObject({ ok: false, step: 'typed' });
    expect(ed.textContent).toBe('');
  });
});
