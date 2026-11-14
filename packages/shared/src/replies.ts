// Replies from people we wrote to (Jibran, 13.11.2026). Two things are decided in code before any model
// sees a reply: a clear "do not write to me again" stops everything for that person, and legal wording
// goes to Jibran without a draft. Everything else is classified by the model and, where an answer makes
// sense, drafted for his approval. Replies are never approved automatically.

export const REPLY_CLASSES = [
  'interested',
  'question',
  'objection',
  'later',
  'not_interested',
  'wrong_person',
  'out_of_office',
  'other',
] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

// What each class means for the inbox: the stored outcome, how urgent it is (1 = answer first) and
// whether an answer is drafted. "Not interested" is final: no draft, no second try.
export const REPLY_HANDLING: Record<
  ReplyClass,
  { outcome: string; priority: 1 | 2 | 3; draft: boolean }
> = {
  interested: { outcome: 'interested', priority: 1, draft: true },
  question: { outcome: 'question', priority: 1, draft: true },
  objection: { outcome: 'objection', priority: 2, draft: true },
  later: { outcome: 'not_now', priority: 2, draft: true },
  not_interested: { outcome: 'not_interested', priority: 3, draft: false },
  wrong_person: { outcome: 'wrong_target', priority: 3, draft: false },
  out_of_office: { outcome: 'out_of_office', priority: 3, draft: false },
  other: { outcome: 'other', priority: 2, draft: false },
};

// "Please do not contact me again", in German and English. Plain "kein Interesse" is NOT here: that is a
// normal no (class not_interested), which already ends the sequence without blocking the person.
const OPT_OUT = [
  /\b(?:bitte\s+)?(?:keine|keinerlei)\s+(?:weiteren?\s+)?(?:nachrichten|kontaktaufnahmen?|anfragen|werbung|akquise|mails?)\b/i,
  /\bnicht\s+(?:mehr|weiter|wieder)\s+(?:an)?(?:schreiben|kontaktieren|melden|belästigen)\b/i,
  /\b(?:schreiben|kontaktieren)\s+sie\s+mich\s+(?:bitte\s+)?nicht\s+(?:mehr|wieder|weiter)\b/i,
  /\bsehen\s+sie\s+(?:bitte\s+)?von\s+(?:weiteren?\s+)?(?:nachrichten|kontaktaufnahmen?|anfragen)\s+ab\b/i,
  /\b(?:von|aus)\s+(?:ihrer|der)\s+liste\s+(?:streichen|entfernen|nehmen|löschen)\b/i,
  /\blassen\s+sie\s+mich\s+(?:bitte\s+)?in\s+ruhe\b/i,
  /\bunerwünschte\s+(?:werbung|nachricht|kontaktaufnahme)\b/i,
  /\b(?:das\s+ist|ist\s+das)\s+spam\b|\bals\s+spam\s+(?:gemeldet|melden)\b/i,
  /\b(?:please\s+)?(?:stop|do\s+not|don'?t)\s+(?:contact(?:ing)?|messag(?:e|ing)|writ(?:e|ing)\s+(?:to\s+)?)\s*me\b/i,
  /\bremove\s+me\s+from\b|\bunsubscribe\b|\bnot\s+contact\s+me\s+again\b/i,
];
// Legal or data-protection wording: Jibran answers these himself.
const ESCALATE = [
  /\b(?:rechts)?anwalt\b|\banwältin\b|\banwaltlich\b|\babmahn(?:ung|en)\b|\bunterlassung(?:serklärung)?\b/i,
  /\bdsgvo\b|\bgdpr\b|\bdatenschutz(?:behörde|beauftragte\w*|verstoß|beschwerde)\b/i,
  /\buwg\b|\bwettbewerbs(?:recht|zentrale|verstoß)\b|\b(?:straf)?anzeige\b|\brechtliche\s+schritte\b/i,
  /\bwoher\s+haben\s+sie\s+meine\s+daten\b|\bauskunft\s+(?:nach|gemäß)\s+art/i,
  /\blawyer\b|\blegal\s+action\b|\bcease\s+and\s+desist\b/i,
];

export function replyPattern(text: string): { kind: 'opt_out' | 'escalate'; match: string } | null {
  const t = text.replace(/\s+/g, ' ');
  for (const re of ESCALATE) {
    const m = t.match(re);
    if (m) return { kind: 'escalate', match: m[0] };
  }
  for (const re of OPT_OUT) {
    const m = t.match(re);
    if (m) return { kind: 'opt_out', match: m[0] };
  }
  return null;
}

export const DEAL_STAGES = ['engaged', 'qualifying', 'meeting', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
