// Text of an element as a reader would see it: <br> and block elements become line breaks, buttons
// ("…more", "Like") and hidden elements are left out. Works without layout (tests, content script).
const BLOCK = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'SECTION',
  'ARTICLE',
  'H1',
  'H2',
  'H3',
  'H4',
  'HEADER',
  'FOOTER',
  'FIGURE',
]);
const SKIP = new Set(['BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'TEMPLATE']);

export function readText(el: Element): string {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? '';
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (SKIP.has(e.tagName) || e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('hidden'))
      return;
    if (e.tagName === 'BR') {
      out += '\n';
      return;
    }
    const block = BLOCK.has(e.tagName);
    if (block) out += '\n';
    for (const c of Array.from(e.childNodes)) walk(c);
    if (block) out += '\n';
  };
  walk(el);
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
