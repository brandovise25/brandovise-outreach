// LinkedIn shows relative ages ("3w", "3 Wo.", "2 months ago", "1 J."). For trigger age checks we
// need the OLDEST the item could be, because "3w" may mean up to 27 days.
const UNITS: [RegExp, number][] = [
  [/^(s|sek|sec|second|seconds|sekunde|sekunden)$/, 0],
  [/^(m|min|mins|minute|minutes|minuten)$/, 0],
  [/^(h|hr|hrs|hour|hours|std|stunde|stunden)$/, 0],
  [/^(d|day|days|t|tg|tag|tage|tagen)$/, 1],
  [/^(w|wk|wks|week|weeks|wo|woche|wochen)$/, 7],
  [/^(mo|mos|month|months|mon|monat|monate|monaten)$/, 30],
  [/^(y|yr|yrs|year|years|j|jahr|jahre|jahren)$/, 365],
];

// Returns the maximum possible age in days, or null when the text is not a relative date.
export function maxAgeDays(relative: string): number | null {
  const m = relative
    .trim()
    .toLowerCase()
    .replace(/^vor\s+/, '')
    .replace(/\s+ago$/, '')
    .replace(/[.•]/g, ' ')
    .match(/^(\d+)\s*([a-zäöü]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!;
  for (const [re, days] of UNITS) {
    if (re.test(unit)) return days === 0 ? 0 : (n + 1) * days - 1;
  }
  return null;
}

// Max trigger ages from the skill ("Triggers"). shared_event also allows upcoming events.
export const TRIGGER_MAX_AGE_DAYS = {
  post: 45,
  role_change: 90,
  hiring: 45,
  company_news: 60,
  shared_event: 30,
  shared_topic: 90,
} as const;
export type TriggerType = keyof typeof TRIGGER_MAX_AGE_DAYS | 'none';

export function triggerFresh(
  type: TriggerType,
  date: { iso?: string | null; relative?: string | null },
  now = new Date(),
): boolean {
  if (type === 'none') return false;
  const limit = TRIGGER_MAX_AGE_DAYS[type];
  let age: number | null = null;
  if (date.iso) {
    const t = Date.parse(date.iso);
    if (Number.isNaN(t)) return false;
    age = Math.floor((now.getTime() - t) / 86_400_000);
    if (age < 0) return type === 'shared_event'; // future: only events may lie ahead
  } else if (date.relative) {
    age = maxAgeDays(date.relative);
  }
  return age !== null && age <= limit;
}
