// Text normalisation shared by every validator: Unicode NFC, lower case, typographic quotes and
// dashes folded to ASCII, and all whitespace runs collapsed to one space.
export function normalize(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True if `quote` appears verbatim in `source`, ignoring case and whitespace differences.
// Used to reject model "evidence" that is not actually on the page.
export function quoteAppears(quote: string, source: string): boolean {
  const q = normalize(quote);
  if (q.length < 3) return false;
  return normalize(source).includes(q);
}

const EMOJI = /\p{Extended_Pictographic}/u;
export const hasEmoji = (text: string) => EMOJI.test(text);

const URL_LIKE =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:de|com|io|net|org|ai|eu)\b(?:\/\S*)?/i;
export const hasUrl = (text: string) => URL_LIKE.test(text);
