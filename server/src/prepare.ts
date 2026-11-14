import {
  cleanFirstName,
  fixUmlauts,
  inviteNoteIssues,
  normalize,
  ungivenNumbers,
  parsePlaybook,
  pickHook,
  rulesForAction,
  salutation,
  scanPhrase,
  triggerTokens,
  validateDraft,
  wellFormed,
  type Hook,
  type HookSignal,
  type PlaybookRule,
} from '@outreach/shared';
import type { AppDeps } from './app.ts';
import { callJson } from './db.ts';
import { runTask } from './ai/run.ts';
import { prepareInviteNotes, prepareMessageOpener, type InviteNoteInput } from './ai/tasks.ts';

// Prepare step (Jibran, 24.10.2026). Due invites and follow-up messages sit in the queue as "scheduled".
// This writes the personal note of an invite (AI, from the fit analysis), checks every text in code and
// moves the rows to the Approve tab ("proposed"). With the setting auto_approve on, rows that pass all
// checks are approved by themselves ("auto"); anything that fails a check always waits for Jibran, with
// the reason. Replies are never touched. Safe to call often: it only handles rows still "scheduled".

interface Candidate {
  id: number;
  action: 'connect' | 'message' | 'withdraw';
  step: number | null;
  message_text: string | null;
  prospect_id: number;
  full_name: string;
  first_name: string | null;
  headline: string | null;
  company: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_description: string | null;
  fit: { evidence?: unknown; reason?: unknown } | null;
  signals?: HookSignal[] | null;
  msg_no?: number | null;
}
interface Applied {
  id: number;
  text: string;
  ok: boolean;
  note: string;
  personalization?: Record<string, unknown>;
}
export interface PrepareResult {
  candidates: number;
  approved: number;
  proposed: number;
  deferred: number; // left for the next call (AI unavailable)
}

const AI_BATCH = 5;

// The stored first name, else the first real name of the full name ("Dr. Kurt Wendler" -> "Kurt").
const TITLES = /^(dr|prof|herr|frau|dipl|mag|ing)\.?$/i;
export function firstNameOf(c: Pick<Candidate, 'first_name' | 'full_name'>): string | null {
  const stored = c.first_name?.trim();
  if (stored) return stored;
  const token = c.full_name.split(/\s+/).find((t) => t && !TITLES.test(t));
  return cleanFirstName(token ?? null, [], '');
}

// Who the campaign writes to: its name and the part of the description before the first " | ".
const audienceOf = (c: Candidate) =>
  [c.campaign_name, c.campaign_description?.split(' | ')[0]].filter(Boolean).join(': ') ||
  'insurance and finance brokers';
const running = new Set<string>();

async function bannedList(deps: AppDeps, userId: string): Promise<string[]> {
  const doc = await callJson<{ body: string }>(deps.db, 'ext_get_doc', [userId, 'banned_phrases']);
  return doc.body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// The playbook that says which website fact a message opens with (editable in Settings).
async function playbook(deps: AppDeps, userId: string): Promise<PlaybookRule[]> {
  try {
    const doc = await callJson<{ body: string }>(deps.db, 'ext_get_doc', [
      userId,
      'signal_playbook',
    ]);
    return parsePlaybook(doc.body);
  } catch {
    return []; // no playbook: messages are written as before, from the profile alone
  }
}

// Checks for any text the AI wrote around a website fact, on top of the usual draft rules.
function hookErrors(body: string, hook: Hook | null, given: string): string[] {
  const errors: string[] = [];
  const scan = scanPhrase(body);
  if (scan) errors.push(`sounds like an audit of their website ("${scan}")`);
  const numbers = ungivenNumbers(body, given);
  if (numbers.length) errors.push(`states a number that was not given (${numbers.join(', ')})`);
  if (hook && !hook.tokens.some((t) => body.toLowerCase().includes(t.toLowerCase())))
    errors.push(`does not mention the chosen fact (${hook.code})`);
  return errors;
}
const personalizationOf = (hook: Hook | null) =>
  hook
    ? { hook: hook.code, angle: hook.angle, platform: hook.platform, evidence: hook.evidence_url }
    : { hook: 'none' };

// The opening goes after the first paragraph ("Guten Tag ..., danke für die Vernetzung.").
export function insertOpener(message: string, opener: string): string {
  const cut = message.indexOf('\n\n');
  return cut < 0
    ? `${message}\n\n${opener}`
    : `${message.slice(0, cut)}\n\n${opener}${message.slice(cut)}`;
}

// What the note must refer to: a distinctive word about the person, from the company, the headline or the
// fit facts (14.11.2026: the company field alone was often "Selbstständig · Self-employed" or a side
// role, so good notes were held back). Never generic role words such as "Inhaber" or
// "Versicherungsmakler", which any note to a broker would contain.
const GENERIC =
  /^(inhaber|gesch[aä]ftsf|gesellschaft|prokurist|versicherung|finanz|makler|berater|beratung|vermittl|vertrieb|selbst|unabh|gmbh|kg$|headline|self$|employed|full$|part$|time$|freelance|freiberuf|teilzeit|vollzeit|gr[uü]nder|founder|owner|ceo$)/i;
// LinkedIn adds the kind of employment to the company: "suited · Self-employed".
export const cleanCompany = (company: string | null | undefined) =>
  (company ?? '')
    .split(/\s+·\s+/)[0]!
    .replace(/^(selbstst[aä]ndig|self-employed|freiberuflich|freelance)$/i, '')
    .trim();
export function distinctiveTokens(c: Pick<Candidate, 'company' | 'headline' | 'fit'>): string[] {
  const from = `${cleanCompany(c.company)} ${c.headline ?? ''} ${facts(c).join(' ')}`;
  return [...new Set(triggerTokens(from).filter((t) => !GENERIC.test(t)))];
}
// Does the note mention one of the tokens? Also without spaces and dots ("suited. business partners"
// for "suitedbusinesspartners").
const squashWords = (t: string) => normalize(t).replace(/[^\p{L}\p{N}]+/gu, '');
export const mentionsAny = (text: string, tokens: string[]) => {
  const flat = squashWords(text);
  return tokens.some((t) => flat.includes(squashWords(t)));
};

const facts = (c: Pick<Candidate, 'fit'>): string[] =>
  (Array.isArray(c.fit?.evidence) ? (c.fit!.evidence as unknown[]) : [])
    .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    .slice(0, 4);

export async function prepareQueue(deps: AppDeps, userId: string): Promise<PrepareResult> {
  const none = { candidates: 0, approved: 0, proposed: 0, deferred: 0 };
  if (running.has(userId)) return none;
  running.add(userId);
  try {
    const cand = await callJson<{ auto: boolean; items: Candidate[] }>(
      deps.db,
      'ext_prepare_candidates',
      [userId],
    );
    if (!cand.items.length) return none;
    const banned = await bannedList(deps, userId);
    const rules = cand.items.some((c) => c.signals?.length) ? await playbook(deps, userId) : [];
    const hookOf = (c: Candidate) => pickHook(c.signals, rules, c.campaign_id);
    const applied: Applied[] = [];
    let deferred = 0;

    // Old invites to withdraw: nothing to write, always for Jibran's click (never auto-approved).
    for (const c of cand.items.filter((x) => x.action === 'withdraw'))
      applied.push({ id: c.id, text: '', ok: true, note: '' });

    // Follow-up messages: the campaign's own text, checked.
    // The first message gets a short opening about one fact of the company's website when one is known.
    // If the opening cannot be written or fails a check, the campaign text goes out unchanged.
    for (const c of cand.items.filter((x) => x.action === 'message')) {
      let text = c.message_text ?? '';
      let used: Hook | null = null;
      const hook = Number(c.msg_no) === 1 ? hookOf(c) : null;
      if (hook && text.trim()) {
        try {
          const task = await prepareMessageOpener(
            {
              full_name: c.full_name,
              headline: c.headline,
              company: c.company,
              hook,
              message: text,
            },
            { db: deps.db, userId },
            audienceOf(c),
          );
          const opener = (await runTask<string>(deps, userId, 'message_opener', task)).output;
          const len = [...opener].length;
          const problems = [
            ...hookErrors(opener, hook, `${hook.fact} ${c.headline ?? ''} ${c.company ?? ''}`),
            ...(len < 40 || len > 260 ? ['length'] : []),
            ...(/[?!]/.test(opener) ? ['question or exclamation'] : []),
            ...validateDraft(opener, rulesForAction('message', banned)).errors,
          ];
          if (!problems.length) {
            text = wellFormed(insertOpener(text, opener));
            used = hook;
          }
        } catch {
          // budget, network or format problem: the campaign text is complete without an opening
        }
      }
      const check = validateDraft(text, rulesForAction('message', banned));
      applied.push({
        id: c.id,
        text,
        ok: check.ok,
        note: check.ok ? '' : `needs a look: ${check.errors.join('; ')}`,
        ...(Number(c.msg_no) === 1 ? { personalization: personalizationOf(used) } : {}),
      });
    }

    // Invites: a personal note per person, written for the campaign's audience, then all checks.
    const invites = cand.items.filter((x) => x.action === 'connect');
    const groups = new Map<string, Candidate[]>();
    for (const c of invites)
      groups.set(c.campaign_id ?? '', [...(groups.get(c.campaign_id ?? '') ?? []), c]);
    const batches = [...groups.values()].flatMap((g) =>
      Array.from({ length: Math.ceil(g.length / AI_BATCH) }, (_, i) =>
        g.slice(i * AI_BATCH, (i + 1) * AI_BATCH),
      ),
    );
    for (const batch of batches) {
      const inputs: InviteNoteInput[] = batch.map((c) => ({
        first_name: firstNameOf(c),
        full_name: c.full_name,
        headline: c.headline,
        company: c.company,
        facts: facts(c),
        hook: hookOf(c),
      }));
      let notes: { index: number; note: string }[];
      try {
        const task = await prepareInviteNotes(
          inputs,
          { db: deps.db, userId },
          audienceOf(batch[0]!),
        );
        notes = (
          await runTask<{ index: number; note: string }[]>(deps, userId, 'invite_note', task)
        ).output;
      } catch {
        deferred += batch.length; // budget, network or format problem: try again on the next call
        continue;
      }
      for (const [k, c] of batch.entries()) {
        const body = notes.find((n) => n.index === k)?.note;
        if (!body) {
          applied.push({
            id: c.id,
            text: c.message_text ?? '',
            ok: false,
            note: 'needs a look: no personal note was written',
          });
          continue;
        }
        const note = fixUmlauts(body.trim());
        const text = `${salutation(firstNameOf(c))}\n\n${note}`;
        // With a website fact the note must mention that fact; otherwise something of the person.
        const hook = hookOf(c);
        const tokens = hook ? [] : distinctiveTokens(c);
        // Website-like names (laufsport-beispiel.de, also in "laufsport-beispiel.de GmbH") are names here, not links.
        const domains =
          `${c.company ?? ''} ${c.headline ?? ''}`.match(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi) ??
          [];
        const checked = domains.reduce((t, d) => t.split(d).join(d.replace(/\./g, ' ')), text);
        const check = validateDraft(checked, rulesForAction('connect', banned));
        const given = `${hook?.fact ?? ''} ${c.headline ?? ''} ${c.company ?? ''} ${facts(c).join(' ')}`;
        const errors = [
          ...check.errors,
          ...(hook
            ? []
            : !tokens.length
              ? ['no distinctive fact about the person to refer to']
              : mentionsAny(note, tokens)
                ? []
                : ['does not mention anything specific about the person']),
          ...hookErrors(note, hook, given),
          ...inviteNoteIssues(note),
        ];
        applied.push({
          id: c.id,
          text: wellFormed(text),
          ok: errors.length === 0,
          note: errors.length ? `needs a look: ${errors.join('; ')}` : '',
          personalization: personalizationOf(hook),
        });
      }
    }

    if (!applied.length) return { ...none, candidates: cand.items.length, deferred };
    const r = await callJson<{ approved: number; proposed: number }>(deps.db, 'ext_prepare_apply', [
      userId,
      JSON.stringify(applied),
      cand.auto,
    ]);
    return { candidates: cand.items.length, approved: r.approved, proposed: r.proposed, deferred };
  } finally {
    running.delete(userId);
  }
}
