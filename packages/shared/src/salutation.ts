import { hasEmoji } from './text.ts';

const COMPANY_MARKERS = /\b(gmbh|ag|ug|kg|ohg|gbr|e\.?\s?k\.?|ltd|inc|llc|se|co\.?)\b/i;

// Cleans a LinkedIn first name with a list of words and characters to drop (kill words / kill characters), and refuses
// names that are not names (company names, empty after cleaning). Returns null when unusable.
export function cleanFirstName(
  raw: string | null | undefined,
  killWords: string[],
  killCharacters: string,
): string | null {
  if (!raw) return null;
  if (COMPANY_MARKERS.test(raw)) return null;
  let s = [...raw].filter((ch) => !killCharacters.includes(ch) && !hasEmoji(ch)).join('');
  const kill = new Set(killWords.map((w) => w.trim().toLowerCase()).filter(Boolean));
  const tokens = s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !kill.has(t.toLowerCase()) && /\p{L}/u.test(t));
  s = tokens[0] ?? '';
  if (!s || s.length < 2) return null;
  // ALL CAPS or all lower -> Title case, keeping hyphenated parts ("ANNA-LENA" -> "Anna-Lena").
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    s = s
      .toLowerCase()
      .split('-')
      .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
      .join('-');
  }
  return s;
}

export function parseKillWords(setting: string | null | undefined): string[] {
  return (setting ?? '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
}

// "Guten Tag Anna," or, without a usable first name, "Guten Tag,". Never guesses Herr/Frau.
export function salutation(firstName: string | null): string {
  return firstName ? `Guten Tag ${firstName},` : 'Guten Tag,';
}
