import type { ApiClient, KeyValueStore } from '@outreach/shared';
import { berlinNow } from './round.ts';

// Automatic prospecting and sending (Jibran, 17.10.2026). Called from the 5-minute alarm. These only
// put jobs into the server queue; the server still checks pause, send times, limits, the daily invite
// target and approvals before anything is handed out.

interface Deps {
  api: ApiClient;
  store: KeyValueStore;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function weekday(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday, like robot_schedule
}

// Same rule as outreach.send_window_open(): no schedule means always open.
export function insideSendWindow(schedule: unknown, day: string, hhmm: string): boolean {
  if (!schedule || typeof schedule !== 'object') return true;
  const wins = (schedule as Record<string, unknown>)[String(weekday(day))];
  if (!Array.isArray(wins)) return false;
  return wins.some((w) => Array.isArray(w) && hhmm >= String(w[0]) && hhmm < String(w[1]));
}

// Send approved items in small batches, 60-120 minutes apart, inside the send times. Live only: in dry
// run the same items would be practised again and again.
export async function maybeAutoSend(deps: Deps): Promise<void> {
  const settings = await deps.api.settings();
  if (!settings.send_auto || settings.paused || settings.ext_dry_run) return;
  const { day, hhmm } = berlinNow();
  if (!insideSendWindow(settings.robot_schedule, day, hhmm)) return;
  const next = (await deps.store.get<string>('send.next')) ?? '';
  if (next && Date.parse(next) > Date.now()) return;
  await deps.store.set('send.next', new Date(Date.now() + rand(60, 120) * 60_000).toISOString());
  const max = 4 + Math.floor(Math.random() * 3); // 4-6 items per batch
  await deps.api.panel('POST', '/ext/jobs', {
    kind: 'send_round',
    params: { trigger: 'auto', max },
  });
}

interface WaitingCounts {
  leads?: number;
  approve?: number;
  approve_contacts?: number;
  approved?: number;
}
// Leads still waiting for Jibran: staged candidates and drafts to approve. Approved queue items do not
// count: old ones (over 14 days) are never sent and blocked prospecting for days (18.10.2026). Suggested
// withdrawals do not count either (17.11.2026: 36 of them paused prospecting); approve_contacts is the
// count without them, approve the older count with them (a server before that change).
export const leadsWaiting = (c: WaitingCounts | undefined) =>
  (c?.leads ?? 0) + (c?.approve_contacts ?? c?.approve ?? 0);

// Two prospect rounds per weekday (Jibran, 13.11.2026): one at a random time 08:00-10:00 and one at 14:00-16:00
// (Berlin). Each slot runs at most once; if Chrome was off, a slot runs as soon as Chrome is on, until 18:00,
// but never two rounds within 3 hours. Skipped while 40 or more leads or drafts already wait for review.
export type ProspectSlot = 'am' | 'pm';
export function dueProspectSlot(
  hhmm: string,
  at: Record<ProspectSlot, string>,
  done: Record<ProspectSlot, boolean>,
  lastRoundMs: number | null,
  nowMs: number,
): ProspectSlot | null {
  if (hhmm >= '18:00') return null;
  if (lastRoundMs !== null && nowMs - lastRoundMs < 3 * 3_600_000) return null;
  for (const slot of ['am', 'pm'] as const) if (!done[slot] && hhmm >= at[slot]) return slot;
  return null;
}

const randomTime = (fromMin: number, toMin: number) => {
  const m = Math.floor(rand(fromMin, toMin));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export async function maybeAutoProspect(deps: Deps): Promise<void> {
  const settings = await deps.api.settings();
  if (!settings.prospect_auto || settings.paused) return;
  const { day, hhmm } = berlinNow();
  const wd = weekday(day);
  if (wd === 0 || wd === 6) return;
  const key = (what: string, slot: ProspectSlot) => `prospect.${what}.${day}.${slot}`;
  const at = {} as Record<ProspectSlot, string>;
  const done = {} as Record<ProspectSlot, boolean>;
  for (const [slot, from, to] of [
    ['am', 480, 600],
    ['pm', 840, 960],
  ] as const) {
    let t = await deps.store.get<string>(key('at', slot));
    if (!t) {
      t = randomTime(from, to);
      await deps.store.set(key('at', slot), t);
    }
    at[slot] = t;
    done[slot] = (await deps.store.get<boolean>(key('done', slot))) === true;
  }
  const last = await deps.store.get<number>('prospect.lastRound');
  const slot = dueProspectSlot(hhmm, at, done, last ?? null, Date.now());
  if (!slot) return;
  await deps.store.set(key('done', slot), true);
  await deps.store.set('prospect.lastRound', Date.now());
  const dash = (await deps.api.panel('GET', '/panel/dashboard')) as { counts?: WaitingCounts };
  if (leadsWaiting(dash.counts) >= 40) return;
  await deps.api.panel('POST', '/ext/jobs', {
    kind: 'prospect_round',
    params: { trigger: 'auto' },
  });
}
