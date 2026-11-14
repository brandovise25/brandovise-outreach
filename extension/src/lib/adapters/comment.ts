import type { CommentAttempt } from '@outreach/shared';
import { normalize } from '@outreach/shared';
import { readText } from './text.ts';
import { linkedInWarning } from './detectors.ts';
import { scrollStep } from './scroller.ts';
import { postLink, postUrnIn } from './activity-id.ts';

// Posts ONE approved comment, started by Jibran's click. Finds the post on the page by its text,
// opens its comment box, types the paragraphs, reads them back and compares with the approved text.
// Practice mode (dryRun) stops there and reports the submit button it found. Live mode presses it and
// checks that the comment appears under the post. No synthetic mouse paths: plain element clicks and
// the editor's own text input.

const REACTIONS_MENU =
  'button[aria-label="Open reactions menu"], button[aria-label="Reaktionsmenü öffnen"]';
const EDITOR =
  '[contenteditable="true"][aria-label="Text editor for creating comment"], [contenteditable="true"][aria-label*="Kommentar" i]';
const OPEN_COMMENT = /^(Comment|Kommentieren|Kommentar)$/i;
const SUBMIT = /^(Comment|Post|Kommentieren|Posten|Reply|Antworten|Senden)$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function postCards(): Element[] {
  return Array.from(document.querySelectorAll(REACTIONS_MENU)).map((b) => {
    let el: Element = b;
    while (el.parentElement && el.parentElement.querySelectorAll(REACTIONS_MENU).length <= 1)
      el = el.parentElement;
    return el;
  });
}

// readText() skips buttons by design (they are not post text), so labels use textContent directly.
const label = (b: Element) =>
  ((b.textContent ?? '').replace(/\s+/g, ' ').trim() || b.getAttribute('aria-label') || '').trim();

function hasCommentButton(el: Element): boolean {
  return Array.from(el.querySelectorAll('button, [role="button"]')).some((b) =>
    OPEN_COMMENT.test(label(b)),
  );
}

function findCard(excerpt: string): Element | null {
  const key = normalize(excerpt).slice(0, 60);
  if (!key) return null;
  const byButton = postCards().find((c) => normalize(readText(c)).includes(key));
  if (byButton) return byButton;
  // Other layouts (company pages, activity pages): find the text block, then the nearest ancestor that
  // also holds a Comment button: that is the post.
  const blocks = Array.from(document.querySelectorAll('p, [dir="ltr"], span'))
    .filter((e) => normalize(e.textContent ?? '').includes(key.slice(0, 40)))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  for (const block of blocks) {
    for (let el: Element | null = block, up = 0; el && up < 25; el = el.parentElement, up++) {
      if (hasCommentButton(el)) return el;
    }
  }
  return null;
}

async function waitFor<T>(fn: () => T | null | undefined, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

function buttonsIn(root: Element): HTMLButtonElement[] {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('button, [role="button"]'),
  ) as HTMLButtonElement[];
}

export async function commentOnPost(opts: {
  text: string;
  excerpt: string;
  dryRun: boolean;
  // Reading the post before opening the comment box, and looking over the typed text before posting.
  readMs?: number;
  reviewMs?: number;
}): Promise<CommentAttempt> {
  const base: CommentAttempt = {
    dryRun: opts.dryRun,
    found: false,
    typed: false,
    button: null,
    clicked: false,
    verified: false,
    postedUrl: null,
    note: '',
  };
  const stop = (note: string, extra: Partial<CommentAttempt> = {}) => ({ ...base, ...extra, note });

  const warning = linkedInWarning(document, location.pathname);
  if (warning) return stop(`Stopped: ${warning}`);

  // 1. Find the post (scroll a little if it is further down an activity page).
  let card = findCard(opts.excerpt);
  for (let i = 0; !card && i < 12; i++) {
    scrollStep(Math.round(rand(300, 500)));
    await sleep(rand(2000, 4000));
    card = findCard(opts.excerpt);
  }
  if (!card) return stop('Could not find the post on the page.');
  // Remember the post's own link, so the next attempt can open it directly.
  const foundUrn = postUrnIn(
    card.closest('[componentkey^="update-card-focus"], [data-urn], [role="listitem"]') ?? card,
  );
  if (foundUrn) base.postLink = postLink(foundUrn);
  card.scrollIntoView({ block: 'center' });
  await sleep(rand(1200, 2500));

  const mine = normalize(opts.text).slice(0, 60);
  if (normalize(readText(card)).includes(mine)) {
    return stop('This comment is already under the post.', { found: true, verified: true });
  }

  // Read the post first, at a person's pace.
  await sleep(opts.readMs ?? rand(2000, 4000));
  if (linkedInWarning(document, location.pathname))
    return stop(`Stopped: ${linkedInWarning(document, location.pathname)}`, { found: true });

  // 2. Open the comment box.
  let editor = card.querySelector<HTMLElement>(EDITOR);
  let opener: HTMLButtonElement | undefined;
  if (!editor) {
    opener = buttonsIn(card).find((b) => OPEN_COMMENT.test(label(b)));
    if (!opener) return stop('No Comment button on this post.', { found: true });
    opener.click();
    editor = await waitFor(
      () => card!.querySelector<HTMLElement>(EDITOR) ?? document.querySelector<HTMLElement>(EDITOR),
      6000,
    );
  }
  if (!editor) return stop('The comment box did not open.', { found: true });

  // 3. Type paragraph by paragraph through the editor's own input handling.
  editor.focus();
  await sleep(rand(400, 900));
  const paragraphs = opts.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = 0; i < paragraphs.length; i++) {
    if (i > 0) {
      document.execCommand('insertParagraph');
      document.execCommand('insertParagraph');
    }
    document.execCommand('insertText', false, paragraphs[i]!);
    await sleep(rand(500, 1200));
  }
  const typedText = normalize(readText(editor));
  const typed = typedText === normalize(paragraphs.join(' '));
  if (!typed)
    return stop(
      'What is in the comment box does not match the approved text. Nothing was posted.',
      { found: true },
    );

  // 4. The submit button appears once there is text: nearest matching button around the editor.
  let scope: Element | null = editor;
  let submit: HTMLButtonElement | undefined;
  for (let up = 0; scope && up < 8 && !submit; up++, scope = scope.parentElement) {
    submit = buttonsIn(scope).find(
      (b) =>
        b !== opener &&
        SUBMIT.test(label(b)) &&
        !b.hasAttribute('disabled') &&
        b.getAttribute('aria-disabled') !== 'true',
    );
  }
  if (!submit)
    return stop('Typed the comment but found no Post/Comment button. Nothing was posted.', {
      found: true,
      typed: true,
    });

  // Look over the typed comment before posting.
  await sleep(opts.reviewMs ?? rand(1500, 3000));

  if (opts.dryRun) {
    return stop(
      `Practice: typed the comment and found the "${label(submit)}" button. Did not press it.`,
      {
        found: true,
        typed: true,
        button: label(submit),
      },
    );
  }

  // 5. Live: press it and check the comment appears. LinkedIn may re-render the post, so the check looks
  // at the whole page (outside any comment box), for up to 30 s.
  const buttonLabel = label(submit);
  submit.click();
  const visible = () => {
    const main = document.querySelector('main') ?? document.body;
    const editors = Array.from(main.querySelectorAll<HTMLElement>(EDITOR));
    let text = normalize(readText(main));
    for (const ed of editors) text = text.replace(normalize(readText(ed)), '');
    return text.includes(mine);
  };
  const appeared = await waitFor(() => (visible() ? true : null), 30000);
  return stop(
    appeared
      ? 'Posted and visible under the post.'
      : 'Pressed the button, but the comment did not show up within 30 s. It is marked "please check" so it is not posted twice.',
    {
      found: true,
      typed: true,
      button: buttonLabel,
      clicked: true,
      verified: !!appeared,
      postedUrl:
        base.postLink ??
        (/\/feed\/update\//.test(location.pathname)
          ? `https://www.linkedin.com${location.pathname}`
          : null),
    },
  );
}
