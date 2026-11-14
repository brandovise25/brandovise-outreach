// The element that actually scrolls the page content. LinkedIn's newer layout scrolls the feed inside its
// own container, so window.scrollBy moves nothing and the page looks "at the bottom" at once
// (11.10.2026: rounds stopped after 3 steps with 8 posts). Picks the largest visible element whose
// content overflows and that can scroll; falls back to the document.

export function scroller(doc: Document = document): Element {
  const page = doc.scrollingElement ?? doc.documentElement;
  const win = doc.defaultView;
  if (page.scrollHeight > page.clientHeight + 200) return page;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of Array.from(doc.querySelectorAll('main, main *, body > div, body > div *'))) {
    if (el.scrollHeight <= el.clientHeight + 200 || el.clientHeight < 200) continue;
    const st = win?.getComputedStyle(el);
    if (!st || !/(auto|scroll|overlay)/.test(st.overflowY)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best ?? page;
}

export function scrollStep(px: number, doc: Document = document) {
  const el = scroller(doc);
  if (el === doc.scrollingElement || el === doc.documentElement)
    doc.defaultView?.scrollBy({ top: px, behavior: 'smooth' });
  else el.scrollBy({ top: px, behavior: 'smooth' });
}

// Position of the scrolling element: how far down, how tall, how much is visible.
export function scrollState(doc: Document = document) {
  const el = scroller(doc);
  return { top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight };
}
