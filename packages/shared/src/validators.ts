import { hasEmoji, hasUrl, normalize, quoteAppears } from './text.ts';
import { humanizerIssues } from './humanizer.ts';

// Default list from docs/reference/skills/brandovise-linkedin-outreach/SKILL.md ("Banned phrases").
// At runtime the list comes from docs.banned_phrases; this copy is the seed and the fallback for tests.
export const DEFAULT_BANNED_PHRASES = [
  'geschäftigen Stadt',
  'Stadt wie',
  'in einer Stadt',
  'busy city',
  'bei dem Wetter',
  'Ich hoffe, es geht Ihnen gut',
  'beeindruckendes Profil',
  'spannendes Profil',
  'beeindruckender Werdegang',
  'impressive profile',
  'bin auf Ihr Profil gestoßen',
  'came across your profile',
  'Menschen wie Sie',
  'Leute wie Sie',
  'zugeschnitten',
  'Vorlage',
  'Template',
  'Kampagne',
  'Sequenz',
  'Zielgruppe',
  'unser System',
  'mein Agent',
  'automatisch generiert',
] as const;

// Words that would reveal the machinery (CLAUDE rule 11), on top of the banned list.
const MACHINERY = [
  'sequence',
  'campaign',
  'target list',
  'zielliste',
  'falsches segment',
  'wrong segment',
];

export function findBannedPhrases(
  text: string,
  phrases: readonly string[] = DEFAULT_BANNED_PHRASES,
): string[] {
  const t = normalize(text);
  return [...phrases, ...MACHINERY].filter((p) => t.includes(normalize(p)));
}

// Informal German address. Word boundaries are Unicode-aware so "Durchlauf" or "Dienst" do not match.
const DU_FORM =
  /(?<![\p{L}])(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure)(?![\p{L}])/iu;
export const usesDuForm = (text: string) => DU_FORM.test(text);

// "Wie viele Stunden ...?" style questions are banned in invite notes.
const TIME_QUESTION =
  /(wie\s+viel(e)?\s+(zeit|stunden)|stunden\s+pro\s+(woche|tag|monat)|how\s+(much\s+time|many\s+hours))[^?]*\?/iu;
export const asksAboutTime = (text: string) => TIME_QUESTION.test(text);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DraftRules {
  maxChars: number;
  softChars?: number;
  bannedPhrases?: readonly string[];
  // Concrete words from the trigger note; at least one must appear when a trigger is used.
  triggerTokens?: string[];
  // Replies may answer in the form the person used ("du"); invites and campaign messages may not.
  allowDuForm?: boolean;
}

// Rules for any text that may be sent: invite notes, message first lines, replies.
export function validateDraft(text: string, rules: DraftRules): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const len = [...text].length;
  if (len === 0) errors.push('empty text');
  if (len > rules.maxChars) errors.push(`too long: ${len} > ${rules.maxChars} characters`);
  else if (rules.softChars && len > rules.softChars)
    warnings.push(`longer than ${rules.softChars} characters`);
  const banned = findBannedPhrases(text, rules.bannedPhrases);
  if (banned.length) errors.push(`banned phrases: ${banned.join(', ')}`);
  if (!rules.allowDuForm && usesDuForm(text)) errors.push('uses du-form instead of Sie');
  if (hasEmoji(text)) errors.push('contains emoji');
  if (hasUrl(text)) errors.push('contains a URL');
  if (asksAboutTime(text)) errors.push('asks about hours or time');
  // Text that reads machine-written (see humanizer.ts): model leakage blocks, the rest is flagged.
  for (const i of humanizerIssues(text)) {
    (i.level === 'error' ? errors : warnings).push(`reads AI-written: ${i.rule} ("${i.match}")`);
  }
  if (rules.triggerTokens?.length) {
    const t = normalize(text);
    if (!rules.triggerTokens.some((tok) => t.includes(normalize(tok)))) {
      errors.push('does not mention any concrete detail of the trigger');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const INVITE_NOTE_RULES = { maxChars: 300, softChars: 200 } as const;

// Concrete tokens of a trigger note: words of 4+ letters that are not filler, plus numbers.
const FILLER = new Set(
  'ihre ihren ihrem ihrer einen einer eines eine dass sich sind haben wurde werden über ueber diese dieser diesem nach beim zum zur ihnen sehr auch noch neue neuen neuer with that this your about from have their'.split(
    ' ',
  ),
);
export function triggerTokens(note: string): string[] {
  return [
    ...new Set(
      normalize(note)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => (w.length >= 4 && !FILLER.has(w)) || /^\d+$/.test(w)),
    ),
  ];
}

export type FitStatus = 'yes' | 'no' | 'unsure';

// A yes/no is only kept when at least one evidence quote is really on the page; otherwise unsure.
export function verifyFit(
  fit: { status: FitStatus; reason: string; evidence: string[] },
  sourceText: string,
): { status: FitStatus; reason: string; evidence: string[]; downgraded: boolean } {
  const evidence = fit.evidence.filter((q) => quoteAppears(q, sourceText));
  if (fit.status !== 'unsure' && evidence.length === 0) {
    return {
      status: 'unsure',
      reason: `${fit.reason} (no verifiable evidence)`,
      evidence,
      downgraded: true,
    };
  }
  return { ...fit, evidence, downgraded: false };
}

// Rules for a queue row's text by action: invite notes are short and Sie-only; replies may mirror the
// person's form of address; everything else is a campaign message in Sie-Form.
export function rulesForAction(action: string, bannedPhrases?: readonly string[]): DraftRules {
  if (action === 'connect') return { ...INVITE_NOTE_RULES, bannedPhrases };
  if (action === 'reply') return { maxChars: 8000, allowDuForm: true, bannedPhrases };
  return { maxChars: 8000, bannedPhrases };
}
