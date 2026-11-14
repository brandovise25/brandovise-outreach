// Deterministic checks for text that reads machine-written, before Jibran sees a draft.
// Rules adapted from sergebulaev/linkedin-skills (MIT License, © 2026 Sergey Bulaev),
// skills/linkedin-humanizer/references/scrub-rules.md (V3), plus German equivalents for Jibran's
// German comments and messages. Principle from the source: single common words are fine, clusters
// are the signal; model leakage and staged constructions are flagged on a single hit.

export interface HumanizerIssue {
  rule: string;
  level: 'error' | 'warn';
  match: string;
}

// Real model leakage: never written by a person.
const FORENSIC: [string, RegExp][] = [
  [
    'tool marker',
    /\b(oaicite|contentReference|turn\d+search\d+|attached_file|grok_card|oai_citation)\b/i,
  ],
  [
    'cutoff disclaimer',
    /\b(as of my (last update|knowledge cutoff|training cutoff)|my (knowledge|training data) (cuts off|extends to)|stand meines wissens)\b/i,
  ],
  [
    'placeholder',
    /\[(your name|your company|name|date|topic|insert [^\]]+|describe [^\]]+|ihr name|firma)\]/i,
  ],
];

// Staged constructions: flagged on one hit (reach-negative per the source's 2026 data).
const STAGED: [string, RegExp][] = [
  [
    'reveal bridge',
    /(^|\n)\s*(the (result|outcome|answer|lesson|catch|kicker|truth)|das ergebnis|die antwort|der haken)\?\s/i,
  ],
  ['reveal bridge', /(^|\n)\s*(here'?s (what|how|why|the thing)|hier ist (was|wie|warum))\b/i],
  [
    'negative parallelism',
    /\b(it'?s not (just |about )?[^,.;\n]{1,40}, it'?s|not [^,.;\n]{1,30}, but|this isn'?t [^.\n]{1,40}\. this is)\b/i,
  ],
  [
    'negative parallelism',
    /\b(es geht nicht (nur )?um [^,.;\n]{1,40}, (sondern|es geht um)|nicht [^,.;\n]{1,30}, sondern [^,.;\n]{1,30}\. punkt)\b/i,
  ],
  ['staccato', /(^|\n)\s*(\p{L}+\. ){2,}\p{L}+\.\s*($|\n)/u],
  ['staccato', /\b(no|kein[e]?) \p{L}+\. (no|kein[e]?) \p{L}+\. (just|only|nur|einfach) \p{L}+/iu],
  [
    'sincerity marker',
    /(^|\n)\s*(let me be (honest|real|direct|clear)|to be (honest|direct|fair|transparent)|real talk|unpopular opinion|ehrlich gesagt|mal ganz ehrlich|unpopuläre meinung)\b/i,
  ],
  [
    'cliché opener',
    /^\s*(in today'?s|have you ever|most people don'?t realize|let me tell you|in der heutigen (zeit|welt)|kennen sie das|haben sie sich (schon mal|jemals) gefragt)\b/i,
  ],
  [
    'cliché closer',
    /(what do you think|thoughts|agree or disagree|let me know in the comments|was meinen sie|was denken sie|wie sehen sie das)\??\s*$/i,
  ],
  [
    'cliché phrase',
    /\b(game[- ]?changer|paradigm shift|move the needle|at the end of the day|in a world where|testament to|let that sink in|deep dive|am ende des tages|lassen sie das (mal )?sacken|in einer welt, in der|ein echter gamechanger|paradigmenwechsel)\b/i,
  ],
];

// Words models over-select (density-scored: 3+ in one paragraph = signal). English from the source,
// German counterparts added for Jibran's language.
const VOCAB = new RegExp(
  '\\b(' +
    [
      'significant(ly)?',
      'crucial(ly)?',
      'notably',
      'particularly',
      'comprehensive',
      'insights?',
      'robust',
      'leverag(e|es|ed|ing)',
      'foster(s|ed|ing)?',
      'landscape',
      'nuanced',
      'multifaceted',
      'holistic',
      'streamlin(e|es|ed|ing)',
      'elevat(e|es|ed|ing)',
      'empower(s|ed|ing)?',
      'utiliz(e|es|ed|ing)',
      'facilitat(e|es|ed|ing)',
      'harness(es|ed|ing)?',
      'unlock(s|ed|ing)?',
      'navigat(e|es|ed|ing)',
      'seamless(ly)?',
      'ecosystem',
      'fundamentally',
      'essentially',
      'ultimately',
      'arguably',
      'undoubtedly',
      'delve',
      'tapestry',
      'realm',
      'pivotal',
      // German
      'entscheidend(e[nrs]?)?',
      'maßgeblich(e[nrs]?)?',
      'ganzheitlich(e[nrs]?)?',
      'nahtlos(e[nrs]?)?',
      'umfassend(e[nrs]?)?',
      'nachhaltig(e[nrs]?)?',
      'zukunftsfähig(e[nrs]?)?',
      'innovativ(e[nrs]?)?',
      'optimier(en|t|ung)',
      'synergie(n)?',
      'mehrwert',
      'spannend(e[nrs]?)?',
      'letztendlich',
      'im kern',
      'grundsätzlich',
      'zweifellos',
      'maßgeschneidert(e[nrs]?)?',
      'skalierbar(e[nrs]?)?',
      'transformation',
      'potenzial(e)?',
      'herausforderung(en)?',
    ].join('|') +
    ')\\b',
  'giu',
);

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

export function humanizerIssues(text: string): HumanizerIssue[] {
  const issues: HumanizerIssue[] = [];
  const t = text.trim();
  for (const [rule, re] of FORENSIC) {
    const m = t.match(re);
    if (m) issues.push({ rule, level: 'error', match: m[0].trim() });
  }
  for (const [rule, re] of STAGED) {
    const m = t.match(re);
    if (m) issues.push({ rule, level: 'warn', match: m[0].trim().slice(0, 80) });
  }
  // Em dashes: capped at ~1 per 100 words (min 1, max 2), never pushed to zero.
  const em = (t.match(/—/g) ?? []).length;
  const cap = Math.max(1, Math.min(2, Math.round(words(t) / 100)));
  if (em > cap)
    issues.push({ rule: 'em dashes', level: 'warn', match: `${em} em dashes (cap ${cap})` });
  // Vocabulary clusters per paragraph.
  for (const p of t.split(/\n\s*\n/)) {
    const hits = p.match(VOCAB) ?? [];
    if (hits.length >= 3)
      issues.push({
        rule: 'AI vocabulary cluster',
        level: 'warn',
        match: hits.slice(0, 5).join(', '),
      });
  }
  // Hollow triads: "X, Y and Z" of abstract words (3+ triads in one short text is a signature).
  const triads = t.match(/\b\p{L}+, \p{L}+,? (and|und) \p{L}+\b/giu) ?? [];
  if (triads.length >= 2)
    issues.push({
      rule: 'stacked lists of three',
      level: 'warn',
      match: triads.slice(0, 2).join(' / '),
    });
  // Fragments for drama: more than 2 sentences under 4 words.
  const fragments = t
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() && words(s) < 4 && !/\?$/.test(s.trim()));
  if (fragments.length > 2)
    issues.push({
      rule: 'too many fragments',
      level: 'warn',
      match: fragments.slice(0, 3).join(' '),
    });
  return issues;
}

export const humanizerWarnings = (text: string) =>
  humanizerIssues(text).map(
    (i) => `${i.level === 'error' ? 'AI leak' : 'reads AI-written'}: ${i.rule} ("${i.match}")`,
  );
