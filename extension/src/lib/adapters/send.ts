import { normalize } from '@outreach/shared';
import { linkedInWarning } from './detectors.ts';
import { stripScripts } from '../redact.ts';

// The page as it is right now (dialog open, text typed), for checking the steps on real HTML.
let snapshot: string | null = null;
export const takeSnapshot = () => {
  const s = snapshot;
  snapshot = null;
  return s;
};
const keep = (on: boolean) => {
  if (!on) return;
  snapshot = stripScripts(document);
  // The shadow layer is not part of the page HTML: append it, or the snapshot shows an empty outlet.
  const layer = shadowLayer();
  if (layer) snapshot += `\n<!-- #interop-outlet shadow root -->\n${layer.innerHTML}`;
};

// Since about 29.10.2026 LinkedIn draws the invite dialog inside the shadow root of
// <div id="interop-outlet" data-testid="interop-shadowdom">; document.querySelector does not see it.
// Content scripts may open a closed root through chrome.dom.
function shadowLayer(): ShadowRoot | null {
  const host = document.getElementById('interop-outlet');
  if (!host) return null;
  if (host.shadowRoot) return host.shadowRoot;
  const dom = (
    globalThis as {
      chrome?: { dom?: { openOrClosedShadowRoot?: (e: HTMLElement) => ShadowRoot | null } };
    }
  ).chrome?.dom;
  return dom?.openOrClosedShadowRoot?.(host) ?? null;
}

// Send actions on LinkedIn, one at a time, in the robot tab. PRACTICE (dry run): everything up to the
// final button is done and read back, then cancelled: the invite dialog is closed, the message box is
// emptied again (so no draft is left), a withdraw is only located. LIVE presses the final button and
// checks the result on the page. Only the profile's own buttons are used (never the sidebar).
// Hooks seen 09./10.10.2026: a[aria-label="Invite <Name> to connect"] (href /preload/custom-invite/),
// a[href*="/messaging/compose/"] "Message", "Pending, click to withdraw invitation sent to <Name>",
// composer [contenteditable][aria-label^="Write a message"] + button.msg-form__send-button,
// a[aria-label="Withdraw invitation sent to <Name>"]. The invite dialog's buttons are matched by text.

export interface SendAttempt {
  practice: boolean;
  ok: boolean; // practice: everything up to the final button worked; live: it was sent and is visible
  step: string; // how far it got
  note: string;
  finalButton: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Withdrawing: how often "Load more" may be clicked on the Sent list (10 invitations each).
const MAX_LOAD_MORE = 45;
export const LOAD_MORE = /^(Load more|Mehr laden|Weitere (laden|anzeigen))$/i;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const text = (e: Element | null | undefined) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
const label = (e: Element) => e.getAttribute('aria-label') ?? text(e);

async function waitFor<T>(fn: () => T | null | undefined, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

function topCard(): Element | null {
  const main = document.querySelector('main');
  return main?.querySelector('section') ?? main ?? null;
}

export function inspectProfile() {
  const top = topCard();
  const labels = Array.from(top?.querySelectorAll('[aria-label]') ?? []).map(
    (e) => e.getAttribute('aria-label') ?? '',
  );
  const connect =
    top?.querySelector<HTMLAnchorElement>('a[aria-label^="Invite "][aria-label$=" to connect"]') ??
    null;
  const message = top?.querySelector<HTMLAnchorElement>('a[href*="/messaging/compose/"]') ?? null;
  return {
    name: text(top?.querySelector('h1, h2')),
    canConnect: !!connect,
    pending: labels.some((l) => /^Pending\b/i.test(l)),
    messageHref: message
      ? new URL(message.getAttribute('href')!, location.origin).toString()
      : null,
    connected: !connect && !!message && !labels.some((l) => /^Follow /.test(l)),
  };
}

function stop(
  practice: boolean,
  step: string,
  note: string,
  extra: Partial<SendAttempt> = {},
): SendAttempt {
  return { practice, ok: false, step, note, finalButton: null, ...extra };
}

// The invite dialog as LinkedIn draws it. Seen so far: a modal with role="dialog" (until 10.2026), the
// same inside the #interop-outlet shadow root (29.10.2026), and since 13.11.2026 a native
// <dialog data-testid="dialog" open> at the top of the page, in which "Add a note" is a link, not a
// button. The minimised messaging bubbles also carry role="dialog" and are never what we wait for.
const DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], .artdeco-modal';
const CHAT =
  '.msg-overlay-conversation-bubble, .msg-overlay-list-bubble, [data-view-name^="message-overlay"]';
export function findDialog(roots: (ParentNode | null | undefined)[]): HTMLElement | null {
  const all = roots
    .flatMap((r) => (r ? Array.from(r.querySelectorAll<HTMLElement>(DIALOG)) : []))
    .filter((e) => !e.closest(CHAT) && !/^Messaging$/i.test(e.getAttribute('aria-label') ?? ''));
  return all.find((e) => e.matches('dialog[open]')) ?? all[0] ?? null;
}
function dialog(): HTMLElement | null {
  return findDialog([document, shadowLayer()]);
}
// A control by its label: a button, or a link or role="button" that LinkedIn uses as one.
export function buttonIn(root: ParentNode, re: RegExp): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>('button, a, [role="button"]')).find(
      (b) =>
        re.test(label(b)) &&
        !(b as HTMLButtonElement).disabled &&
        b.getAttribute('aria-disabled') !== 'true',
    ) ?? null
  );
}
async function closeDialog() {
  const d = dialog();
  if (!d) return;
  const x = buttonIn(d, /^(Dismiss|Close|Cancel|Schließen|Abbrechen|Verwerfen)$/i);
  if (x) x.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(800);
  // LinkedIn may ask "Discard?" after text was typed
  const confirm = dialog();
  const discard = confirm && buttonIn(confirm, /^(Discard|Verwerfen)$/i);
  if (discard) discard.click();
  await sleep(500);
}

function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  el.focus();
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function connectWithNote(
  note: string,
  practice: boolean,
  snap = false,
): Promise<SendAttempt> {
  const warn = linkedInWarning(document, location.pathname);
  if (warn) return stop(practice, 'start', `Stopped: ${warn}`);
  const p = inspectProfile();
  // Already pending on LinkedIn (sent earlier, e.g. by a round whose result was not recorded): the
  // invitation exists, so this counts as done and nothing is sent again (14.11.2026).
  if (p.pending)
    return {
      practice,
      ok: true,
      step: 'already_pending',
      note: 'Already pending on LinkedIn; nothing sent again.',
      finalButton: null,
    };
  if (!p.canConnect)
    return stop(
      practice,
      'profile',
      p.connected
        ? 'Already connected.'
        : 'No Connect button on this profile (maybe under "More").',
    );
  const btn = topCard()!.querySelector<HTMLElement>(
    'a[aria-label^="Invite "][aria-label$=" to connect"]',
  )!;
  btn.scrollIntoView({ block: 'center' });
  await sleep(rand(800, 1600));
  btn.click();
  const d = await waitFor(dialog, 8000);
  if (!d) {
    keep(true); // the page as it is now, for finding out what LinkedIn showed instead
    return stop(practice, 'dialog', 'The invite dialog did not open.');
  }
  await sleep(rand(800, 1500));
  // The note box: a <textarea> until 11.2026; since 14.11.2026 a rich-text editor
  // (div[contenteditable][role="textbox"], TipTap) like the message composer.
  const noteBox = () =>
    dialog()?.querySelector<HTMLElement>(
      'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]',
    ) ?? null;
  // LinkedIn opens the dialog first and fills it a moment later, sometimes replacing the element
  // (14.11.2026: "Add a note" missing although the snapshot shows it). So wait for the content and
  // always look in the dialog as it is now, not the one found when it opened.
  const addNote = () => {
    const now = dialog();
    return now ? buttonIn(now, /^(Add a note|Notiz hinzufügen)$/i) : null;
  };
  await waitFor(() => noteBox() ?? addNote(), 8000);
  let area = noteBox();
  if (!area) {
    const add = addNote();
    if (!add) {
      keep(true); // the dialog as LinkedIn shows it (13.11.2026: 'Add a note' missing in live runs)
      await closeDialog();
      return stop(practice, 'dialog', 'No "Add a note" button in the invite dialog.');
    }
    add.click();
    area = await waitFor(noteBox, 6000);
  }
  if (!area) {
    keep(true);
    await closeDialog();
    return stop(practice, 'note', 'The note box did not appear.');
  }
  if (area instanceof HTMLTextAreaElement) setTextarea(area, note);
  else await typeRich(area, note);
  await sleep(rand(1500, 3000));
  // Rich text keeps one <p> per paragraph, so compare without whitespace.
  const squash = (x: string) => normalize(x).replace(/\s/g, '');
  const typed = area instanceof HTMLTextAreaElement ? area.value : text(area);
  if (squash(typed) !== squash(note)) {
    await closeDialog();
    return stop(
      practice,
      'note',
      'The note box does not hold the approved text. Nothing was sent.',
    );
  }
  // Send can stay disabled for a moment after typing (14.11.2026: one invite failed here while the
  // ones before and after went through). Wait for it; if it never enables, keep the page and say what
  // the dialog shows (a character counter or a notes limit, for example).
  const SEND = /^(Send|Send invitation|Senden|Einladung senden)$/i;
  const send = await waitFor(() => {
    const now = dialog();
    return now ? buttonIn(now, SEND) : null;
  }, 6000);
  if (!send) {
    const now = dialog();
    const disabled =
      now &&
      Array.from(now.querySelectorAll<HTMLElement>('button')).some((b) => SEND.test(label(b)));
    const hint = now
      ? Array.from(now.querySelectorAll<HTMLElement>('p, span, [role="alert"]'))
          .map((e) => text(e))
          .find((t) => /\d+\s*\/\s*\d+|limit|premium|characters|zeichen/i.test(t) && t.length < 160)
      : undefined;
    keep(true);
    await closeDialog();
    return stop(
      practice,
      'send',
      `Typed the note but ${disabled ? 'the Send button stayed disabled' : 'found no Send button'}${hint ? ` (dialog: "${hint}")` : ''}. Nothing was sent.`,
      { step: 'typed' },
    );
  }
  const finalButton = label(send);
  if (practice) {
    keep(snap);
    await closeDialog();
    return {
      practice,
      ok: true,
      step: 'typed',
      note: `Practice: typed the note and found "${finalButton}". Did not press it; dialog closed.`,
      finalButton,
    };
  }
  send.click();
  const pending = await waitFor(() => (inspectProfile().pending ? true : null), 10000);
  return pending
    ? {
        practice,
        ok: true,
        step: 'sent',
        note: 'Invitation sent; the profile shows "Pending".',
        finalButton,
      }
    : stop(
        practice,
        'sent',
        'Pressed Send, but the profile does not show "Pending" yet. Check it.',
        { finalButton },
      );
}

function composer(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.msg-form__contenteditable[contenteditable="true"]') ??
    document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"][aria-label^="Write a message"]',
    ) ??
    document.querySelector<HTMLElement>('[contenteditable="true"][aria-label*="message" i]')
  );
}
// Types into a rich-text box (message composer, invite note): one paragraph per block, an empty line
// between them, the way a person types it.
async function typeRich(ed: HTMLElement, body: string) {
  ed.focus();
  if (text(ed)) {
    document.execCommand('selectAll');
    document.execCommand('delete');
    await sleep(400);
  }
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = 0; i < paragraphs.length; i++) {
    if (i > 0) {
      document.execCommand('insertParagraph');
      document.execCommand('insertParagraph');
    }
    document.execCommand('insertText', false, paragraphs[i]!);
    await sleep(rand(600, 1400));
  }
}
async function clearComposer(ed: HTMLElement) {
  ed.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  await sleep(500);
}

export async function sendMessage(
  body: string,
  practice: boolean,
  snap = false,
): Promise<SendAttempt> {
  const warn = linkedInWarning(document, location.pathname);
  if (warn) return stop(practice, 'start', `Stopped: ${warn}`);
  const ed = await waitFor(composer, 10000);
  if (!ed) return stop(practice, 'composer', 'No message box found.');
  ed.scrollIntoView({ block: 'center' });
  await sleep(rand(800, 1600));
  if (text(ed)) await clearComposer(ed); // an old draft must not be sent along
  ed.focus();
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = 0; i < paragraphs.length; i++) {
    if (i > 0) {
      document.execCommand('insertParagraph');
      document.execCommand('insertParagraph');
    }
    document.execCommand('insertText', false, paragraphs[i]!);
    await sleep(rand(600, 1400));
  }
  // The box holds one <p> per paragraph and textContent joins them without a space, so compare
  // without whitespace (29.10.2026: a two-paragraph message failed this check and was not sent).
  const squash = (s: string) => normalize(s).replace(/\s/g, '');
  if (squash(text(ed)) !== squash(paragraphs.join(' '))) {
    await clearComposer(ed);
    return stop(
      practice,
      'typed',
      'The message box does not hold the approved text. Nothing was sent; the box was emptied.',
    );
  }
  const form = ed.closest('form') ?? document;
  const send =
    form.querySelector<HTMLButtonElement>('button.msg-form__send-button:not([disabled])') ??
    buttonIn(form instanceof Document ? form.body : form, /^(Send|Senden)$/i);
  if (!send) {
    await clearComposer(ed);
    return stop(practice, 'send', 'Typed the message but found no Send button. Nothing was sent.');
  }
  const finalButton = label(send);
  if (practice) {
    keep(snap);
    await clearComposer(ed);
    const empty = !text(composer());
    return {
      practice,
      ok: empty,
      step: 'typed',
      note: empty
        ? `Practice: typed the message and found "${finalButton}". Did not press it; the box was emptied again.`
        : 'Practice: typed, but the box could not be emptied again. Please check the conversation for a draft.',
      finalButton,
    };
  }
  send.click();
  const first = normalize(paragraphs[0]!).slice(0, 50);
  const seen = await waitFor(
    () =>
      Array.from(
        document.querySelectorAll('.msg-s-event-listitem__body, .msg-s-message-list__event'),
      ).some((e) => normalize(text(e)).includes(first)) || null,
    10000,
  );
  return seen
    ? {
        practice,
        ok: true,
        step: 'sent',
        note: 'Message sent and visible in the conversation.',
        finalButton,
      }
    : stop(
        practice,
        'sent',
        'Pressed Send, but the message is not visible yet. Check the conversation.',
        { finalButton },
      );
}

export async function withdrawInvite(name: string, practice: boolean): Promise<SendAttempt> {
  const warn = linkedInWarning(document, location.pathname);
  if (warn) return stop(practice, 'start', `Stopped: ${warn}`);
  const find = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label^="Withdraw invitation sent to "]'),
    ).find(
      (e) =>
        normalize(e.getAttribute('aria-label')!.replace(/^Withdraw invitation sent to /, '')) ===
        normalize(name),
    ) ?? null;
  let w = find();
  // The list shows 10 invitations, newest first, and grows only by its "Load more" button (17.10.2026:
  // scrolling alone never found invitations older than the first page).
  const count = () =>
    document.querySelectorAll('[aria-label^="Withdraw invitation sent to "]').length;
  let loads = 0;
  for (let i = 0; !w && i < MAX_LOAD_MORE; i++) {
    const more = Array.from(document.querySelectorAll<HTMLButtonElement>('main button')).find((b) =>
      LOAD_MORE.test((b.textContent ?? '').trim()),
    );
    if (!more) break;
    const before = count();
    more.scrollIntoView({ block: 'center' });
    await sleep(rand(600, 1400));
    more.click();
    loads++;
    await waitFor(() => (count() > before ? true : null), 8000);
    await sleep(rand(1500, 3000));
    const warn2 = linkedInWarning(document, location.pathname);
    if (warn2) return stop(practice, 'find', `Stopped: ${warn2}`);
    w = find();
  }
  if (!w)
    return stop(
      practice,
      'find',
      `No pending invitation to ${name} on the page (${count()} listed after ${loads} "Load more" clicks).`,
    );
  w.scrollIntoView({ block: 'center' });
  if (practice)
    return {
      practice,
      ok: true,
      step: 'found',
      note: `Practice: found the Withdraw button for ${name}. Did not press it.`,
      finalButton: label(w),
    };
  w.click();
  const d = await waitFor(dialog, 6000);
  const confirm = d && buttonIn(d, /^(Withdraw|Zurückziehen)$/i);
  if (!confirm)
    return stop(practice, 'confirm', 'The confirmation did not appear. Nothing was withdrawn.');
  confirm.click();
  const gone = await waitFor(() => (find() ? null : true), 8000);
  return gone
    ? {
        practice,
        ok: true,
        step: 'sent',
        note: `Invitation to ${name} withdrawn.`,
        finalButton: 'Withdraw',
      }
    : stop(practice, 'sent', 'Pressed Withdraw, but the invitation is still listed. Check it.');
}
