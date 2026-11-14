// Matching a company to people and websites by name (company-first discovery, 13.11.2026). Deliberately
// strict: a wrong match would put one company's facts into a message to someone else.

export const foldText = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const GENERIC_WORD =
  /^(gmbh|mbh|ug|ag|kg|ohg|gbr|ev|co|inc|ltd|und|and|the|der|die|das|shop|online|store|handel|handels|group|gruppe|holding|deutschland|germany|international|versicherungsmakler|versicherung|versicherungen|makler|finanz|finanzen|immobilien|hausverwaltung|steuerberater|steuerberatung|kanzlei|beratung|consulting|solutions|service|services|agentur|studio|team|haftungsbeschraenkt|www)$/;

// The distinctive words of a company name ("Laufshop Müller GmbH" -> laufshop, mueller).
export function companyWords(name: string): string[] {
  return foldText(name)
    .split(' ')
    .filter((w) => w.length >= 4 && !GENERIC_WORD.test(w));
}

// Does this website belong to the company of that name? A distinctive word of the name must be in the
// domain ("Laufshop Müller GmbH" and laufshop-mueller.de).
export function domainMatchesCompany(domain: string, company: string): boolean {
  const label = foldText(domain.split('.')[0] ?? '').replace(/ /g, '');
  const words = companyWords(company);
  if (!label || !words.length) return false;
  return words.some((w) => label.includes(w));
}

const TITLE =
  /^(dr|prof|dipl|ing|mag|med|jur|rer|nat|mba|msc|bsc|ba|ma|herr|frau|kfm|kffr|oec|pol|phil|h|c)$/;
const nameTokens = (name: string) =>
  foldText(name)
    .split(' ')
    .filter((t) => t.length > 1 && !TITLE.test(t));

export interface PersonCard {
  name: string;
  headline: string | null;
  snippet: string | null;
}

// Which search result is the owner named in the Impressum? First and last name must both be in the
// result's name, and the result must mention the company (in the headline or the "Current: ..." line).
// Returns the index, or -1 when no result is clearly that person.
export function ownerMatch(
  people: readonly PersonCard[],
  owner: string,
  company: { name: string | null; domain: string },
): number {
  const want = nameTokens(owner);
  if (want.length < 2) return -1;
  const first = want[0]!;
  const last = want[want.length - 1]!;
  const words = [
    ...new Set([
      ...companyWords(company.name ?? ''),
      ...companyWords(company.domain.split('.')[0] ?? ''),
    ]),
  ];
  if (!words.length) return -1;
  const hits = people
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => {
      const tokens = nameTokens(p.name);
      if (!tokens.includes(first) || !tokens.includes(last)) return false;
      const about = foldText(`${p.headline ?? ''} ${p.snippet ?? ''}`).replace(/ /g, '');
      return words.some((w) => about.includes(w));
    });
  return hits.length === 1 ? hits[0]!.i : -1;
}
