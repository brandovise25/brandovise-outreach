// Checks for the personal note of a connection request (14.11.2026, after the first notes since the
// dialog fix went out). Things a German reader notices at once, decided in code, not by the model.

// "möchte ich Sie gern vernetzen" (wrong: one connects oneself with someone).
const WRONG_CONNECT = /\bSie\s+(?:gerne?\s+|hiermit\s+)?(?:zu\s+)?vernetzen\b|\bvernetze\s+Sie\b/i;
// Grading the person or sounding like a pitch: "passen Sie gut in mein Netzwerk", "ist mir aufgefallen".
const GRADING =
  /\bpass(?:en|t)\s+(?:Sie\s+)?(?:gut|genau|perfekt|ideal|hervorragend)\b|\bin mein(?:em)? Netzwerk\b|\bist mir (?:dabei |sofort |direkt )?aufgefallen\b|\bhat mich (?:darauf )?gebracht\b|\bgenau (?:in diesen Kreis|dazu)\b|\bgenau (?:die|der|das) Richtige\b/i;

export function inviteNoteIssues(body: string): string[] {
  const issues: string[] = [];
  const t = body.trim();
  if ([...t].length < 60) issues.push(`note too short (${[...t].length} characters)`);
  const wrong = t.match(WRONG_CONNECT);
  if (wrong) issues.push(`wrong German ("${wrong[0]}"): "mich mit Ihnen vernetzen"`);
  const grade = t.match(GRADING);
  if (grade) issues.push(`grades the person or pitches ("${grade[0]}")`);
  return issues;
}

// Ordinary words typed without umlauts (often copied from a company name such as "Maklerbuero"):
// written the normal way. Only whole words or word endings from this list are changed.
const UMLAUT_WORDS: [RegExp, string][] = [
  [/buero\b/g, 'büro'],
  [/Buero\b/g, 'Büro'],
  [/\bfuer\b/g, 'für'],
  [/\bFuer\b/g, 'Für'],
  [/\bueber\b/g, 'über'],
  [/\bUeber\b/g, 'Über'],
  [/\bmoechte\b/g, 'möchte'],
  [/\bkoennen\b/g, 'können'],
  [/\bgruesse\b/g, 'grüße'],
  [/\bGruesse\b/g, 'Grüße'],
  [/\bGeschaeftsfuehrer(in)?\b/g, 'Geschäftsführer$1'],
  [/\bVersicherungsbuero\b/g, 'Versicherungsbüro'],
];
export function fixUmlauts(text: string): string {
  return UMLAUT_WORDS.reduce((t, [re, to]) => t.replace(re, to), text);
}
