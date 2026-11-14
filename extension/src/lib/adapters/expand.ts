// Opens LinkedIn's "…see more" toggles in the page's main column, like a reader who wants the full
// About text or post. Only text-expanding toggles: never Connect, Follow, Message, More, links to
// other pages, or anything in the sidebar. Returns how many were opened.

const SEE_MORE = /^(…|\.\.\.)?\s*(see more|show more|more|mehr anzeigen|mehr)$/i;
const NEVER =
  /connect|follow|message|invite|vernetzen|folgen|nachricht|withdraw|send|post|comment/i;

export function seeMoreToggles(doc: Document): HTMLElement[] {
  const main = doc.querySelector('main') ?? doc.body;
  const found = new Set<HTMLElement>();
  for (const el of Array.from(
    main.querySelectorAll<HTMLElement>(
      'button, [role="button"], [data-testid="expandable-text-button"]',
    ),
  )) {
    if (el.closest('aside, a[href], [role="dialog"]')) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const aria = el.getAttribute('aria-label') ?? '';
    if (NEVER.test(aria) || NEVER.test(text)) continue;
    if (
      el.getAttribute('data-testid') === 'expandable-text-button' ||
      SEE_MORE.test(text) ||
      /^see more|show more/i.test(aria)
    )
      found.add(el);
  }
  return [...found];
}

export async function expandSeeMore(doc: Document, max = 4): Promise<number> {
  let opened = 0;
  for (const el of seeMoreToggles(doc).slice(0, max)) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
    el.click();
    opened++;
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 4000));
  }
  return opened;
}
