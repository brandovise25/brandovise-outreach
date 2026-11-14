// Reads a LinkedIn profile (read-only). Stable hooks seen 10.10.2026 (captures in fixtures/raw):
//   profile:    data-sdui-screen ...profile.Profile; top card = first <section> with the name as <h2>;
//               then headline, "Company · School", location, "Contact info", connections count.
//               Sections are found by their <h2> ("About", "Activity", ...). Sidebars are <aside>.
//               Actions: a[aria-label="Invite <Name> to connect"], a[href*="/messaging/compose/"],
//               "Follow <Name>", "Pending, click to withdraw invitation sent to <Name>", button "More".
//   experience: data-sdui-screen ...ProfileExperienceDetails; one [componentkey^="entity-collection-item"]
//               per role: <p> title, company (· employment type), dates, location, then a description.
// Experience only renders on the main page after scrolling, so it is read from /details/experience/.

export interface ProfileTop {
  name: string;
  headline: string | null;
  companyLine: string | null; // "Company · School" under the headline
  location: string | null;
  connections: string | null; // "135 connections", "500+ connections"
  followers: string | null;
  about: string | null;
  actions: { connect: boolean; message: boolean; follow: boolean; pending: boolean };
  degreeGuess: '1st' | 'not-1st' | null; // from the buttons: Connect/Pending = not connected yet
}
export interface ExperienceItem {
  title: string;
  company: string | null;
  dates: string | null; // "Jan 2022 - Present · 4 yrs 10 mos"
  current: boolean;
  location: string | null;
  description: string | null;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// Leaf text blocks (<p> or <span>/<div> without block children), outside the sidebar.
function leaves(root: Element): string[] {
  return Array.from(root.querySelectorAll('p, h1, h2, h3, li > span, div'))
    .filter((e) => !e.closest('aside') && !e.querySelector('p, div, h1, h2, h3, li'))
    .map((e) => clean(e.textContent))
    .filter(Boolean);
}

function sectionByHeading(doc: Document, heading: RegExp): Element | null {
  return (
    Array.from(doc.querySelectorAll('section')).find(
      (s) => !s.closest('aside') && heading.test(clean(s.querySelector('h2')?.textContent)),
    ) ?? null
  );
}

export function readProfileTop(doc: Document): ProfileTop | null {
  const title = clean(doc.title).replace(/\s*\|\s*LinkedIn\s*$/i, '');
  const sections = Array.from(doc.querySelectorAll('section')).filter((s) => !s.closest('aside'));
  const top =
    sections.find((s) => title && clean(s.querySelector('h2')?.textContent) === title) ??
    sections.find(
      (s) => s.querySelector('h2') && /connections|Contact info/i.test(s.textContent ?? ''),
    );
  if (!top) return null;
  const name = clean(top.querySelector('h2')?.textContent) || title;
  const lines = leaves(top).filter(
    (l) => l !== name && !/^[·•]\s*(1st|2nd|3rd)\+?$/.test(l) && l !== '·',
  );
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const contact = idx(/^Contact info$/i);
  const before = contact >= 0 ? lines.slice(0, contact) : lines.slice(0, 4);
  const labels = Array.from(top.querySelectorAll('[aria-label]')).map(
    (e) => e.getAttribute('aria-label') ?? '',
  );
  const texts = Array.from(top.querySelectorAll('a, button')).map((e) => clean(e.textContent));
  const actions = {
    connect: labels.some((l) => /^Invite .+ to connect$/.test(l)),
    message: !!top.querySelector('a[href*="/messaging/compose/"]') || texts.includes('Message'),
    follow: labels.some((l) => /^Follow /.test(l)) || texts.includes('Follow'),
    pending: labels.some((l) => /^Pending\b/i.test(l)),
  };
  const aboutSec = sectionByHeading(doc, /^About$/i);
  const about = aboutSec
    ? clean(
        leaves(aboutSec)
          .filter((l) => !/^About$|^…?\s*see more$|^…more$/i.test(l))
          .join('\n'),
      ) || null
    : null;
  const all = clean(doc.body.textContent);
  return {
    name,
    headline: before[0] ?? null,
    companyLine: before.length > 2 ? before[1]! : null,
    location: before.length > 2 ? before[before.length - 1]! : (before[1] ?? null),
    connections: lines.find((l) => /connections?$/i.test(l))
      ? `${lines[idx(/connections?$/i) - 1] ?? ''} ${lines[idx(/connections?$/i)]}`.trim()
      : null,
    followers: all.match(/([\d.,]+\+?)\s+followers/i)?.[0] ?? null,
    about: about?.slice(0, 3000) ?? null,
    actions,
    degreeGuess: actions.connect || actions.pending ? 'not-1st' : actions.message ? '1st' : null,
  };
}

export function readExperienceDetails(doc: Document): ExperienceItem[] {
  const items: ExperienceItem[] = [];
  for (const el of Array.from(doc.querySelectorAll('[componentkey^="entity-collection-item"]'))) {
    if (el.closest('aside')) continue;
    const ps = Array.from(el.querySelectorAll('p'))
      .map((p) => clean(p.textContent))
      .filter(Boolean);
    if (!ps.length) continue;
    const dateIdx = ps.findIndex(
      (p) => /\b(19|20)\d{2}\b|Present|heute/i.test(p) && /[-–]|·/.test(p),
    );
    const title = ps[0]!;
    const company = dateIdx > 1 ? ps[1]! : null;
    const dates = dateIdx >= 0 ? ps[dateIdx]! : null;
    const after = dateIdx >= 0 ? ps.slice(dateIdx + 1) : ps.slice(2);
    const location =
      after[0] && after[0].length < 80 && /,|Germany|Deutschland|Remote|Area/i.test(after[0])
        ? after[0]
        : null;
    const description = after.filter((p) => p !== location).join('\n') || null;
    items.push({
      title,
      company,
      dates,
      current: /Present|heute/i.test(dates ?? ''),
      location,
      description: description?.slice(0, 1500) ?? null,
    });
  }
  return items;
}
