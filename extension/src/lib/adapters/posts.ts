import type { FeedPost } from '@outreach/shared';
import { readText } from './text.ts';
import { COMMENT_AREA, postUrnIn } from './activity-id.ts';

// Reads LinkedIn posts (feed, a single post, a profile's activity) from the rendered page.
// LinkedIn's class names are random hashes, so this relies on what is stable: every post has exactly
// one "Open reactions menu" button and a permalink to /feed/update/urn:li:...; the author is the first
// profile or company link; the post text is the longest text block. Read-only: nothing is clicked.

const REACTIONS_MENU = ['Open reactions menu', 'Reaktionsmenü öffnen'];
const AUTHOR_MENU =
  /^(Open control menu for post by|Hide post by|Steuerungsmenü für Beitrag von|Beitrag von) /i;
const SOCIAL_PROOF =
  /\b(likes? this|loves? this|celebrates this|supports this|finds this \w+|is curious about this|reposted this|commented( on this)?|replied|gefällt das|kommentiert|hat (das|dies) geteilt|teilt)\b/i;
const PROMOTED = /\b(Promoted|Gesponsert|Anzeige)\b/;
const RELATIVE_AGE = /(?:^|\s|•)(\d+\s?(?:s|m|h|d|w|mo|yr|min|std|t|wo|mon|j)\.?)(?=\s|•|$)/i;

function count(text: string, words: RegExp): number | null {
  const m = text.match(new RegExp(`(\\d[\\d.,]*\\s?[KkMm]?)\\s+(?:${words.source})`, 'i'));
  if (!m) return null;
  const raw = m[1]!.replace(/\s/g, '');
  const n = Number.parseFloat(raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return Math.round(/k$/i.test(raw) ? n * 1000 : /m$/i.test(raw) ? n * 1_000_000 : n);
}

// The largest ancestor of `start` that still contains exactly one reactions-menu button.
function postContainer(button: Element, root: Element): Element {
  let el: Element = button;
  while (el.parentElement && el.parentElement !== root) {
    const parent = el.parentElement;
    const buttons = parent.querySelectorAll(
      REACTIONS_MENU.map((l) => `button[aria-label="${l}"]`).join(','),
    );
    if (buttons.length > 1) break;
    el = parent;
  }
  return el;
}

function absolute(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

// "Rena G. Verified Profile 1st", "🪪 Gerd Ebner" -> plain names.
export function cleanAuthor(name: string): string {
  return name
    .replace(/\s*(Verified Profile|Verifiziertes Profil|Premium|Influencer|Top Voice)\b.*$/i, '')
    .replace(/\s*[•·]?\s*\d+(st|nd|rd|th)\+?$/i, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.)]+$/gu, '')
    .trim();
}

export function readPosts(doc: Document): FeedPost[] {
  const root = doc.querySelector('main') ?? doc.body;
  const buttons = Array.from(
    root.querySelectorAll(REACTIONS_MENU.map((l) => `button[aria-label="${l}"]`).join(',')),
  );
  const posts: FeedPost[] = [];
  const seen = new Set<string>();

  for (const button of buttons) {
    // A comment under a post has its own reactions button: it is not a post.
    if (button.closest(COMMENT_AREA)) continue;
    const box = postContainer(button, root);
    const permalink = box.querySelector<HTMLAnchorElement>('a[href*="/feed/update/urn:li:"]');
    // The feed has no post links; the card's hidden key holds the post id (see activity-id.ts).
    const card =
      box.closest('[componentkey^="update-card-focus"], [data-urn], [role="listitem"]') ?? box;
    const urn =
      permalink?.getAttribute('href')?.match(/urn:li:(?:activity|share|ugcPost):\d+/)?.[0] ??
      postUrnIn(card);

    // Post text: the longest paragraph-like block.
    const blocks = Array.from(box.querySelectorAll('p, [dir="ltr"]'))
      .map((e) => ({ e, t: readText(e) }))
      .sort((a, b) => b.t.length - a.t.length);
    const textBlock = blocks[0];
    if (!textBlock || textBlock.t.length < 20) continue;
    const text = textBlock.t.replace(/…\s*more$/i, '').trim();

    // Author. A card may start with "X likes this / commented / reposted this": X is NOT the author.
    // LinkedIn names the real author in the post's menu buttons ("Open control menu for post by Y",
    // "Hide post by Y"); without those, links inside such a social-proof line are skipped.
    const menuLabel = Array.from(box.querySelectorAll('button[aria-label]'))
      .map((b) => b.getAttribute('aria-label') ?? '')
      .find((l) => AUTHOR_MENU.test(l));
    const namedAuthor = menuLabel?.replace(AUTHOR_MENU, '').trim() || null;
    const links = Array.from(
      box.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]'),
    ).filter((a) => !textBlock.e.contains(a) && readText(a).length >= 2);
    const inSocialLine = (a: Element) =>
      SOCIAL_PROOF.test(readText(a.closest('p, span, div') ?? a));
    const authorLink =
      (namedAuthor &&
        links.find((a) =>
          `${a.getAttribute('aria-label') ?? ''} ${readText(a)}`.includes(namedAuthor),
        )) ||
      links.find((a) => !inSocialLine(a));
    const headerText = authorLink ? readText(authorLink.closest('div') ?? authorLink) : '';
    // Drop badges like "• 1st", "· 2nd", "Follow", "Premium" that sit next to the name.
    const headerLines = headerText
      .split('\n')
      .filter(
        (l) =>
          !/^[•·\s]*(\d+(st|nd|rd|th)\+?|\d+\.?\s?Grad|Follow|Folgen|Following|Premium|Verified|Verifiziert)?[•·\s]*$/i.test(
            l,
          ),
      );
    const author =
      namedAuthor ?? (authorLink ? readText(authorLink).split('\n')[0] : headerLines[0]) ?? '';
    if (!author) continue;

    const all = readText(box);
    const key = `${urn ?? author}|${text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const media = box.querySelector('video')
      ? 'video'
      : box.querySelector('iframe[title*="document" i], [aria-label*="document" i]')
        ? 'document'
        : box.querySelector('[aria-roledescription="carousel"], [aria-label*="carousel" i]')
          ? 'carousel'
          : Array.from(box.querySelectorAll('figure img')).some((img) => !authorLink?.contains(img))
            ? 'image'
            : 'none';

    posts.push({
      author: cleanAuthor(author).slice(0, 200) || author.slice(0, 200),
      authorHeadline:
        headerLines
          .find((l) => l !== author && !RELATIVE_AGE.test(l) && !/followers|Follower/.test(l))
          ?.slice(0, 400) ?? null,
      authorProfile: absolute(authorLink?.getAttribute('href') ?? null),
      authorFollowers: all.match(/(\d[\d.,]*\s?[KkMm]?)\s+(followers|Follower)/)?.[0] ?? null,
      text: text.slice(0, 5000),
      relativeDate:
        all
          .split('\n')
          .map((l) => l.match(RELATIVE_AGE)?.[1])
          .find(Boolean)
          ?.trim() ?? null,
      reactions: count(all, /reactions?|Reaktionen|likes?/),
      comments: count(all, /comments?|Kommentare?/),
      media,
      promoted:
        PROMOTED.test(headerText) ||
        all
          .split('\n')
          .slice(0, 8)
          .some((l) => /^\[?(Promoted|Gesponsert|Anzeige)\]?$/i.test(l.trim())),
      urn,
      url: urn
        ? `https://www.linkedin.com/feed/update/${urn}/`
        : absolute(permalink?.getAttribute('href') ?? null),
    });
  }
  return posts;
}
