// Which fact a message should open with (Jibran, 13.11.2026). A lead's company has signals read from its
// public website. The playbook, an editable text, says per campaign which combination of signals leads
// to which offer angle and how to open. The first matching rule wins. The choice is made in code, never
// by the model; the model only phrases the opening. Absences ("no chat") may steer the choice but are
// never given to the model as a fact, because a missing widget is a weak observation.

export interface HookSignal {
  code: string;
  value_text: string | null;
  value_num: number | null;
  confidence?: number;
  evidence_url?: string | null;
}

interface Condition {
  code: string;
  absent: boolean;
  min: number | null;
}
export interface PlaybookRule {
  campaign: string; // campaign id, or '*' for all
  conditions: Condition[];
  angle: string;
  hint: string;
}
export interface Hook {
  code: string; // the signal the opening refers to
  angle: string;
  hint: string;
  fact: string; // German, given to the model
  tokens: string[]; // one of these must appear in the opening
  evidence_url: string | null;
  platform: string | null; // shop system, for the statistics
}

export const DEFAULT_PLAYBOOK = `# Which fact a message opens with. One rule per line:
#   SIGNALS => angle | how to open
# "+" means all signals must be there, "!" in front means the signal must be missing,
# "CATALOG_SIZE>=500" compares the number. The first rule that matches wins.
# [campaign-id] starts the rules of one campaign, [*] applies to every campaign.
# Angles: support (support chat for e-mail and WhatsApp), forecast (demand forecast and
# product recommendations from past sales), office (AI agents for office routine).

[ecommerce-first-level-support]
HIRING_SUPPORT_ROLE => support | They are hiring for customer service. Mention that you saw they are looking for support staff.
SUPPORT_WHATSAPP + NO_CHAT_WIDGET => support | The shop answers customers on WhatsApp. Mention WhatsApp as their support channel.
SUPPORT_WHATSAPP => support | The shop answers customers on WhatsApp. Mention WhatsApp as their support channel.
SHOP_PLATFORM + CATALOG_SIZE>=500 => forecast | A large range on this shop system. Mention the shop system and the wide range, no number.
CHAT_WIDGET => support | The shop already has a chat on the site. Mention the chat.
SHOP_PLATFORM => support | Mention the shop system their shop runs on.

[*]
ONLINE_BOOKING => office | The office offers online appointment booking. Mention it.
SUPPORT_WHATSAPP => office | The office can be reached on WhatsApp. Mention it.
`;

export function parsePlaybook(text: string): PlaybookRule[] {
  const rules: PlaybookRule[] = [];
  let campaign = '*';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      campaign = section[1]!.trim();
      continue;
    }
    const m = line.match(/^(.+?)=>\s*([a-z0-9_-]+)\s*(?:\|\s*(.*))?$/i);
    if (!m) continue;
    const conditions = m[1]!
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p): Condition | null => {
        const c = p.match(/^(!)?\s*([A-Z][A-Z0-9_]+)\s*(?:>=\s*(\d+))?$/);
        return c ? { code: c[2]!, absent: !!c[1], min: c[3] ? Number(c[3]) : null } : null;
      });
    if (!conditions.length || conditions.some((c) => !c)) continue;
    rules.push({
      campaign,
      conditions: conditions as Condition[],
      angle: m[2]!.toLowerCase(),
      hint: (m[3] ?? '').trim(),
    });
  }
  return rules;
}

// What may be said about a signal, and the words by which the opening is recognised as referring to it.
// Signals without an entry (absences, technical ones) can steer a rule but are never the stated fact.
const FACTS: Record<string, (s: HookSignal) => { fact: string; tokens: string[] } | null> = {
  SHOP_PLATFORM: (s) =>
    s.value_text ? { fact: `Der Shop läuft auf ${s.value_text}.`, tokens: [s.value_text] } : null,
  SUPPORT_WHATSAPP: () => ({
    fact: 'Kunden können den Shop bzw. das Büro per WhatsApp erreichen.',
    tokens: ['whatsapp'],
  }),
  CHAT_WIDGET: () => ({ fact: 'Auf der Website gibt es einen Chat.', tokens: ['chat'] }),
  HIRING_SUPPORT_ROLE: (s) => ({
    fact: `Auf der Karriereseite wird Verstärkung im Kundenservice gesucht${s.value_text ? ` ("${s.value_text}")` : ''}.`,
    tokens: ['kundenservice', 'kundensupport', 'support', 'verstärkung', 'stelle', 'suchen'],
  }),
  ONLINE_BOOKING: () => ({
    fact: 'Termine lassen sich online buchen.',
    tokens: ['termin', 'buchung', 'buchen'],
  }),
  TRUSTED_SHOPS: () => ({
    fact: 'Der Shop trägt das Trusted-Shops-Siegel.',
    tokens: ['trusted'],
  }),
  NEWSLETTER_TOOL: () => ({
    fact: 'Der Shop verschickt einen Newsletter.',
    tokens: ['newsletter'],
  }),
  CATALOG_SIZE: () => ({
    fact: 'Der Shop führt ein großes Sortiment.',
    tokens: ['sortiment', 'artikel', 'produkte'],
  }),
};

const USABLE = 0.7; // weaker observations are not relied on, except as "missing" conditions

export function pickHook(
  signals: readonly HookSignal[] | null | undefined,
  rules: readonly PlaybookRule[],
  campaignId: string | null,
): Hook | null {
  if (!signals?.length) return null;
  const by = new Map(signals.map((s) => [s.code, s]));
  const has = (c: Condition) => {
    const s = by.get(c.code);
    // "!CHAT_WIDGET" and the NO_... signals: a condition, whatever its confidence.
    if (c.absent) return !s;
    if (!s) return false;
    if (c.min !== null) return (s.value_num ?? 0) >= c.min;
    return c.code.startsWith('NO_') || (s.confidence ?? 1) >= USABLE;
  };
  const ordered = [
    ...rules.filter((r) => campaignId && r.campaign === campaignId),
    ...rules.filter((r) => r.campaign === '*'),
  ];
  for (const rule of ordered) {
    if (!rule.conditions.every(has)) continue;
    for (const c of rule.conditions.filter((x) => !x.absent)) {
      const s = by.get(c.code)!;
      const f = FACTS[c.code]?.(s);
      if (!f) continue;
      return {
        code: c.code,
        angle: rule.angle,
        hint: rule.hint,
        fact: f.fact,
        tokens: f.tokens,
        evidence_url: s.evidence_url ?? null,
        platform: by.get('SHOP_PLATFORM')?.value_text ?? null,
      };
    }
  }
  return null;
}

// A message must not sound as if the person's website was audited ("ich habe Ihre Seite analysiert").
const SCAN =
  /\b(analysiert|analyse ihrer|gescannt|gecrawlt|ausgewertet|durchleuchtet|unter die lupe|audit|website[- ]check gemacht|(?:ihre|ihren|ihrer)\s+(?:web)?(?:seite|site|shop)\s+(?:habe ich\s+)?(?:mir\s+)?(?:genau(?:er)?\s+)?(?:geprüft|untersucht|durchgesehen|angeschaut und))/i;
export function scanPhrase(text: string): string | null {
  return text.match(SCAN)?.[0] ?? null;
}

// Numbers in a written text that appear nowhere in what the writer was given.
export function ungivenNumbers(text: string, given: string): string[] {
  const known = new Set(given.match(/\d+/g) ?? []);
  return [...new Set(text.match(/\d+/g) ?? [])].filter((n) => !known.has(n));
}
