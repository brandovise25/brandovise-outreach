// Reads the comments under a post (post page, activity "Comments" page, or a feed card with its comment
// section open). Read-only. Hooks seen 09./21.10.2026:
//   [componentkey^="CommentComponentReference_urn:li:comment:(activity:<post>,<comment>)"]  one comment
//   button[aria-label="View more options for <Name>’s comment."]                         its author
//   [data-testid="expandable-text-box"]                                                  its text
//   "<n> reaction(s)"                                                                     its likes
// A reply sits inside its parent's component and starts with a mention link (<a><strong>Name</strong></a>).

export interface PostComment {
  id: string | null; // urn:li:comment:(activity:…,…)
  author: string;
  profile: string | null;
  headline: string | null;
  text: string;
  reactions: number | null;
  reply: boolean; // a reply to another comment
  mentions: string | null; // the person a reply starts with
}

const COMMENT = '[componentkey^="CommentComponentReference_"]';
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function ownText(box: Element): { text: string; mention: string | null } {
  const copy = box.cloneNode(true) as Element;
  copy
    .querySelectorAll('button, [data-testid="expandable-text-button"]')
    .forEach((b) => b.remove());
  const first = copy.querySelector('a strong');
  const mention =
    first && copy.textContent?.trimStart().startsWith(clean(first.textContent))
      ? clean(first.textContent)
      : null;
  return { text: clean(copy.textContent), mention };
}

export function readPostComments(doc: Document = document): PostComment[] {
  const out: PostComment[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll(COMMENT))) {
    const key = el.getAttribute('componentkey') ?? '';
    const id = key.replace(/^CommentComponentReference_/, '') || null;
    // The comment's own parts only: skip what belongs to replies nested inside it.
    const mine = (sel: string) =>
      Array.from(el.querySelectorAll(sel)).find((n) => n.closest(COMMENT) === el) ?? null;
    const menu = mine('button[aria-label^="View more options for "]');
    const author = clean(menu?.getAttribute('aria-label'))
      .replace(/^View more options for /, '')
      .replace(/[’']s comment\.?$/, '');
    const box = mine('[data-testid="expandable-text-box"]');
    if (!author || !box) continue;
    const { text, mention } = ownText(box);
    if (!text || seen.has(`${id}|${text}`)) continue;
    seen.add(`${id}|${text}`);
    const body = (mention ? text.slice(mention.length) : text).replace(/^[\s,;:.\-–]+/, '').trim();
    if (!body) continue;
    const link = mine('a[href*="/in/"], a[href*="/company/"]') as HTMLAnchorElement | null;
    const reactions = clean(
      Array.from(el.querySelectorAll('span'))
        .filter((s) => s.closest(COMMENT) === el)
        .map((s) => s.textContent ?? '')
        .find((t) => /^\s*[\d.,]+\s+reactions?\s*$/i.test(t)),
    );
    const headline = Array.from(el.querySelectorAll('a p'))
      .filter((p) => p.closest(COMMENT) === el)
      .map((p) => clean(p.textContent))
      .find((t) => t && !t.startsWith(author));
    const parent = el.parentElement?.closest(COMMENT);
    out.push({
      id,
      author,
      profile: link?.getAttribute('href')?.split('?')[0] ?? null,
      headline: headline ?? null,
      text: body,
      reactions: reactions ? Number(reactions.replace(/[^\d]/g, '')) : null,
      reply: !!parent || !!mention,
      mentions: mention,
    });
  }
  return out;
}

// LinkedIn's own "Load more comments" button under a post, pressed like a reader would. True if pressed.
const MORE_COMMENTS =
  /^(load more comments|show more comments|weitere kommentare (laden|anzeigen)|mehr kommentare( laden| anzeigen)?)$/i;
export function loadMoreComments(doc: Document = document): boolean {
  const b = Array.from(doc.querySelectorAll<HTMLButtonElement>('main button, button')).find(
    (x) =>
      MORE_COMMENTS.test(clean(x.textContent) || clean(x.getAttribute('aria-label'))) &&
      !x.disabled,
  );
  if (!b) return false;
  b.scrollIntoView({ block: 'center' });
  b.click();
  return true;
}
