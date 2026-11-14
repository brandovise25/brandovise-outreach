import { readText } from './text.ts';

// Reads LinkedIn people-search results (/search/results/people/). Read-only. Stable hooks (seen
// 09.10.2026): each result is [componentkey="SearchResults<member id>"]; inside, the profile link
// a[href*="/in/"] with the name, " • 2nd" degree, then headline and location paragraphs, an optional
// "Current: …" snippet, and the action: a[aria-label="Invite <Name> to connect"], "Pending, click to
// withdraw invitation sent to <Name>", Message or Follow. Next page: pagination-controls-next-button-visible.

export interface SearchPerson {
  name: string;
  profileUrl: string;
  memberId: string | null; // ACoAA… (stable profile id)
  degree: '1st' | '2nd' | '3rd' | null;
  headline: string | null;
  location: string | null;
  snippet: string | null; // "Current: …" / "Past: …" line LinkedIn shows for the search terms
  action: 'connect' | 'pending' | 'message' | 'follow' | null;
}

function profileUrl(href: string): string | null {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const m = u.pathname.match(/^\/in\/[^/]+/);
    return m ? `https://www.linkedin.com${decodeURI(m[0])}/` : null;
  } catch {
    return null;
  }
}

const slugOf = (a: Element) => profileUrl(a.getAttribute('href') ?? '');

// "Anna, Ben & 11 other mutual connections": links to other people inside a result.
const MUTUAL = /mutual connection|gemeinsame[rn]? Kontakt/i;
const isMutual = (a: Element) => MUTUAL.test(a.closest('p')?.textContent ?? '');

// The largest ancestor of the name link that holds no other person's name link.
function cardOf(link: Element, root: Element, url: string, names: Element[]): Element {
  let el: Element = link;
  while (el.parentElement && el.parentElement !== root) {
    const parent = el.parentElement;
    if (names.some((a) => a !== link && parent.contains(a) && slugOf(a) !== url)) break;
    el = parent;
  }
  return el;
}

export function readSearchResults(doc: Document): { people: SearchPerson[]; hasNext: boolean } {
  // The whole body: results are nested links (a profile link around mutual-connection links), which an
  // HTML parser re-nests outside <main> when a saved page is loaded in tests. Sidebars are skipped.
  const root = doc.body;
  const people: SearchPerson[] = [];
  const seen = new Set<string>();
  // Each result is one big link to the profile around photo, name, headline and location; mutual
  // connections inside it are separate small links.
  const all = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).filter(
    (a) => !a.closest('aside') && !isMutual(a),
  );
  const cards = all.filter((a) => a.querySelector('figure, img, p, div') && slugOf(a));
  const nameLinks = cards.length ? cards : all.filter((a) => readText(a).length >= 2);
  for (const link of nameLinks) {
    const url = slugOf(link);
    if (!url || seen.has(url)) continue;
    const card = cardOf(link, root, url, nameLinks);
    seen.add(url);
    const memberId =
      Array.from(card.querySelectorAll('[componentkey^="SearchResults"]'))
        .map(
          (e) =>
            e.getAttribute('componentkey')!.match(/^SearchResults(?:snippet_)?(ACoAA[\w-]+)$/)?.[1],
        )
        .find(Boolean) ?? null;
    const paras = Array.from(card.querySelectorAll('p, div'))
      .filter((e) => !e.querySelector('p, div') && !MUTUAL.test(e.textContent ?? ''))
      .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const labels = Array.from(card.querySelectorAll('[aria-label]')).map(
      (e) => e.getAttribute('aria-label') ?? '',
    );
    // The name: from the action button's label ("Invite Anna Muster to connect"), else the first line.
    const fromLabel = labels
      .map(
        (l) =>
          l.match(/^Invite (.+) to connect$/)?.[1] ??
          l.match(/invitation sent to (.+)$/)?.[1] ??
          l.match(/^(?:Follow|Message) (.+)$/)?.[1],
      )
      .find(Boolean);
    const DEGREE = /^•?\s*(1st|2nd|3rd)\+?$/;
    const degreeLeaf = paras.find((p) => DEGREE.test(p) || /•\s*(1st|2nd|3rd)/.test(p));
    const degree = (degreeLeaf ?? card.textContent ?? '').match(/•\s*(1st|2nd|3rd)/)?.[1] as
      SearchPerson['degree'] | undefined;
    const name = (fromLabel ?? paras[0] ?? '').replace(/\s*•.*$/, '').trim();
    if (!name) continue;
    const rest = paras.filter(
      (p) =>
        p !== degreeLeaf &&
        !p.startsWith(name) &&
        !/^(Connect|Message|Follow|Pending|Vernetzen|Nachricht|Folgen|Verified|Premium)$/i.test(p),
    );
    const snippet =
      rest.find((p) => /^(Current|Past|Summary|Skills|Aktuell|Früher):/i.test(p)) ?? null;
    const info = rest.filter((p) => p !== snippet);
    const texts = Array.from(card.querySelectorAll('a, button')).map((e) => readText(e).trim());
    const action: SearchPerson['action'] = labels.some((l) => /^Invite .+ to connect$/.test(l))
      ? 'connect'
      : labels.some((l) => /^Pending\b/i.test(l))
        ? 'pending'
        : texts.includes('Message')
          ? 'message'
          : texts.includes('Follow')
            ? 'follow'
            : null;
    people.push({
      name: name.slice(0, 200),
      profileUrl: url,
      memberId,
      degree: degree ?? null,
      headline: info[0]?.slice(0, 400) ?? null,
      location: info[1]?.slice(0, 200) ?? null,
      snippet: snippet?.slice(0, 400) ?? null,
      action,
    });
  }
  const hasNext = !!doc.querySelector('[data-testid="pagination-controls-next-button-visible"]');
  return { people, hasNext };
}
