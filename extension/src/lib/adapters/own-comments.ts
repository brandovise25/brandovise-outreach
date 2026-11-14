import { COMMENT_AREA } from './activity-id.ts';

// Reads the comments a person wrote, from their /recent-activity/comments/ page (read-only).
// Stable hooks seen 09.10.2026: each comment is [componentkey^="CommentComponentReference_urn:li:comment:"];
// its author is named in button[aria-label="View more options for <Name>’s comment."]; the text is in
// [data-testid="expandable-text-box"]; the age ("35m", "3d") is a short line under the author.
// The post it answers is the card's own text outside the comment area. The page owner comes from the
// title "Activity | <Name> | LinkedIn". Replies by other people in the same thread are skipped.

export interface OwnComment {
  text: string;
  date: string | null;
  on: string | null; // start of the post it answers
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const authorOf = (el: Element) =>
  (
    el.querySelector('button[aria-label^="View more options for "]')?.getAttribute('aria-label') ??
    ''
  )
    .replace(/^View more options for /, '')
    .replace(/[’']s comment\.?$/, '')
    .trim();

// The page owner: from the title ("(3) Activity | Name | LinkedIn"), else the most frequent comment
// author on their own comments page.
export function pageOwner(doc: Document): string | null {
  const title = clean(doc.title || doc.querySelector('title')?.textContent).replace(
    /^\(\d+\)\s*/,
    '',
  );
  const parts = title.split('|').map((p) => p.trim());
  if (parts.length >= 3 && /^Activity$/i.test(parts[0]!)) return parts[1]!;
  const counts = new Map<string, number>();
  for (const el of Array.from(
    doc.querySelectorAll('[componentkey^="CommentComponentReference_"]'),
  )) {
    const a = authorOf(el);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}

export function readOwnComments(doc: Document, owner = pageOwner(doc)): OwnComment[] {
  if (!owner) return [];
  const out: OwnComment[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(
    doc.querySelectorAll('[componentkey^="CommentComponentReference_"]'),
  )) {
    const label =
      el
        .querySelector('button[aria-label^="View more options for "]')
        ?.getAttribute('aria-label') ?? '';
    const author = label
      .replace(/^View more options for /, '')
      .replace(/[’']s comment\.?$/, '')
      .trim();
    if (author !== owner) continue;
    // the comment's own text (not a nested reply inside it)
    const box = Array.from(el.querySelectorAll('[data-testid="expandable-text-box"]')).find(
      (b) => b.closest('[componentkey^="CommentComponentReference_"]') === el,
    );
    const text = (box?.textContent ?? '').replace(/…\s*more$/i, '').trim();
    if (text.length < 3 || seen.has(text)) continue;
    seen.add(text);
    const date =
      Array.from(el.querySelectorAll('p'))
        .map((p) => clean(p.textContent))
        .find((t) => /^\d+\s?(s|m|h|d|w|mo|yr)$/.test(t)) ?? null;
    const card = el.closest('[componentkey^="update-card-focus"], [role="listitem"]');
    const post = card
      ? Array.from(card.querySelectorAll('[data-testid="expandable-text-box"]')).find(
          (b) => !b.closest(COMMENT_AREA),
        )
      : null;
    out.push({
      text: text.slice(0, 3000),
      date,
      on: post ? clean(post.textContent).slice(0, 300) : null,
    });
  }
  return out;
}
