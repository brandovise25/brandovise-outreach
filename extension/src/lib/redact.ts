import { UI_VOCABULARY } from './i18n.ts';

// Redacts a LinkedIn page for use as a test fixture. Keeps the DOM structure, class names, roles,
// LinkedIn's own interface words and date/duration tokens. Replaces every other word (names,
// headlines, About text, posts, company names) with x-runs of similar length, so a fixture shows
// how the page is built but not who is on it. Runs inside the extension before anything is saved.

const DROP_ELEMENTS = 'script, style, noscript, template, code, iframe, link, meta, object, embed';
const KEEP_ATTRS = new Set([
  'class',
  'role',
  'type',
  'tabindex',
  'dir',
  'lang',
  'hidden',
  'disabled',
]);
const REDACT_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'title',
  'alt',
  'placeholder',
  'aria-valuetext',
]);
// aria attributes that only wire up the UI (no text), and data attributes that name components.
const ARIA_WIRING =
  /^aria-(hidden|expanded|controls|labelledby|describedby|haspopup|pressed|selected|current|level|live|modal|disabled|checked)$/;
const KEEP_DATA = new Set([
  'id',
  'data-view-name',
  'data-test-icon',
  'data-test-id',
  'data-control-name',
]);

const MONTHS =
  /^(jan|feb|mar|mär|märz|apr|may|mai|jun|juni|jul|juli|aug|sep|sept|oct|okt|nov|dec|dez)\.?$/i;
const DURATION =
  /^(\d+|yrs?|mos?|mo|w|d|h|m|jahr|jahre|mon\.?|monat|monate|wo\.?|t\.?|std\.?|min\.?)$/i;
const NUMERIC_OR_PUNCT = /^[\d\s.,:;·•|+\-–—/()%#&!?'"«»…]*$/u;

export function redactWord(word: string): string {
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!bare) return word;
  const lower = bare.toLowerCase();
  if (
    UI_VOCABULARY.has(lower) ||
    MONTHS.test(bare) ||
    DURATION.test(bare) ||
    /^\d+[a-z]{1,3}$/i.test(bare)
  ) {
    return word;
  }
  if (/^\d{4}$/.test(bare)) return word; // years
  return word.replace(bare, 'x'.repeat(Math.min(Math.max(bare.length, 2), 8)));
}

export function redactText(text: string): string {
  if (NUMERIC_OR_PUNCT.test(text)) return text;
  return text.replace(/\S+/g, redactWord);
}

let slugCounter = 0;
const slugMap = new Map<string, string>();
// Long ids (post URNs, member ids) get a consistent fake number of the same length, so distinct posts
// stay distinct in a fixture without revealing the real id.
const idMap = new Map<string, string>();
export function fakeDigits(d: string): string {
  if (!idMap.has(d)) idMap.set(d, String(idMap.size + 1).padStart(d.length, '9'));
  return idMap.get(d)!;
}
function fakeSlug(slug: string): string {
  if (!slugMap.has(slug)) slugMap.set(slug, `person-${++slugCounter}`);
  return slugMap.get(slug)!;
}

export function redactHref(href: string): string {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    if (u.hostname !== 'www.linkedin.com' && !u.hostname.endsWith('.linkedin.com'))
      return 'https://example.com/';
    let path = decodeURIComponent(u.pathname)
      .replace(/^\/in\/([^/]+)/, (_, s: string) => `/in/${fakeSlug(s)}`)
      .replace(/^\/company\/([^/]+)/, '/company/company-x')
      .replace(/\d{6,}/g, fakeDigits);
    if (/^\/(feed|posts)\/[^/]+-[^/]+/.test(path))
      path = path.replace(/\/posts\/[^/]+/, '/posts/post-x');
    return `https://www.linkedin.com${path}`;
  } catch {
    return '#';
  }
}

// Element ids can embed the profile slug ("ProfilePostConnectDrawer_<slug>") and member URNs
// ("...refACoAAB..."). Known slugs become their fake name; URNs and slug-like tokens are replaced.
export function redactId(id: string): string {
  let out = id;
  for (const [real, fake] of slugMap) out = out.split(real).join(fake);
  return (
    out
      .replace(/ACoAA[A-Za-z0-9_-]{8,}?(?=_K[A-Z]|$|[^A-Za-z0-9_-])/g, 'URNX')
      .replace(/ACoAA[A-Za-z0-9_-]+/g, 'URNX')
      // any hyphenated token ("anna-wagner", "anna-wagner-12345") is treated as a profile slug
      .replace(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu, 'person-x')
      .replace(/\d{6,}/g, fakeDigits)
  );
}

export function redactDocument(doc: Document): string {
  slugCounter = 0;
  slugMap.clear();
  idMap.clear();
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  // Learn every profile slug first, so ids that embed one can be rewritten consistently.
  root.querySelectorAll('a[href*="/in/"]').forEach((a) => redactHref(a.getAttribute('href') ?? ''));
  const pageSlug = doc.location?.pathname.match(/^\/in\/([^/]+)/)?.[1];
  if (pageSlug) redactHref(`/in/${pageSlug}/`);
  root.querySelectorAll(DROP_ELEMENTS).forEach((el) => el.remove());
  root.querySelectorAll('svg').forEach((el) => el.replaceChildren());

  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'href') el.setAttribute('href', redactHref(attr.value));
      else if (name === 'id') el.setAttribute('id', redactId(attr.value));
      else if (REDACT_ATTRS.has(name)) el.setAttribute(name, redactText(attr.value));
      else if (name === 'data-urn' || name === 'data-id')
        el.setAttribute(name, attr.value.replace(/\d{6,}/g, fakeDigits));
      else if (!(KEEP_ATTRS.has(name) || ARIA_WIRING.test(name) || KEEP_DATA.has(name)))
        el.removeAttribute(attr.name);
    }
  }

  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) t.data = redactText(t.data);

  return '<!doctype html>\n' + root.outerHTML;
}

// For local-only raw captures: the real page, minus scripts, styles and embedded JSON blobs.
export function stripScripts(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  root.querySelectorAll(DROP_ELEMENTS).forEach((el) => el.remove());
  return '<!doctype html>\n' + root.outerHTML;
}
