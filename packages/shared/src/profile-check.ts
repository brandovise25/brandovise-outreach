import { z } from 'zod';
import { humanizerIssues } from './humanizer.ts';
import type { VoiceSamples } from './voice.ts';

// Profile check for Jibran's own LinkedIn profile: deterministic findings from what the voice job read,
// plus AI rewrites that may only use facts from his own texts. Checklist adapted from
// sergebulaev/linkedin-skills (MIT), skills/linkedin-profile-optimizer (headline formula
// "what you do | who you help | result", About hook in the first ~270 characters, 7-step About,
// Experience with outcomes, Featured, Skills, custom URL).

export type CheckStatus = 'pass' | 'needs-work' | 'fail' | 'unknown';
export interface ProfileFinding {
  section:
    | 'headline'
    | 'about'
    | 'experience'
    | 'url'
    | 'activity'
    | 'featured'
    | 'skills'
    | 'photo-banner';
  status: CheckStatus;
  note: string;
}

export const DEFAULT_PROFILE_KEYWORDS = [
  'Versicherungsmakler',
  'Makler',
  'Finanzmakler',
  'Immobilien',
  'Steuerberater',
  'KI',
  'KI-Agenten',
  'Automatisierung',
  'CRM',
  'Zoho',
  'HubSpot',
  'AMEISE',
  'n8n',
];
const BUZZ =
  /\b(passionate|driven|results[- ]oriented|thought leader|transformative|cutting[- ]edge|unlock|synergy|innovative|seasoned|leidenschaftlich|innovativ|ganzheitlich)\b/gi;

const has = (text: string, kw: string) =>
  new RegExp(`(^|[^\\p{L}])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(
    text,
  );
const found = (text: string, kws: string[]) => kws.filter((k) => has(text, k));

// "3d" / "2w" / "1mo" / "1yr" → days (approximate)
export function relativeDays(s: string | null | undefined): number | null {
  const m = (s ?? '').match(/(\d+)\s?(m|h|d|w|mo|yr)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return { m: 0, h: 0, d: n, w: n * 7, mo: n * 30, yr: n * 365 }[m[2] as 'd'] ?? null;
}

export function profileFindings(
  s: VoiceSamples,
  keywords = DEFAULT_PROFILE_KEYWORDS,
): ProfileFinding[] {
  const out: ProfileFinding[] = [];
  const p = s.profile;
  const head = (p.headline ?? '').trim();
  const headKw = found(head, keywords);
  if (!head) out.push({ section: 'headline', status: 'fail', note: 'No headline was found.' });
  else {
    const issues: string[] = [];
    if ([...head].length < 80) issues.push(`only ${[...head].length} of 220 characters used`);
    if (/\b(he\/him|she\/her|they\/them|er\/ihm|sie\/ihr)\b/i.test(head))
      issues.push('pronouns take space without telling clients anything');
    if (headKw.length < 3)
      issues.push(
        `only ${headKw.length} search keyword${headKw.length === 1 ? '' : 's'} (${headKw.join(', ') || 'none'})`,
      );
    const buzz = head.match(BUZZ);
    if (buzz) issues.push(`buzzwords: ${[...new Set(buzz)].join(', ')}`);
    out.push({
      section: 'headline',
      status: issues.length ? (headKw.length === 0 ? 'fail' : 'needs-work') : 'pass',
      note: issues.length ? issues.join('; ') : `Keywords: ${headKw.join(', ')}`,
    });
  }

  const about = (p.about ?? '').trim();
  if (!about) out.push({ section: 'about', status: 'fail', note: 'No About text was found.' });
  else {
    const hook = about.slice(0, 270);
    const issues: string[] = [];
    const len = [...about].length;
    if (len < 600) issues.push(`short (${len} characters; 1,000-1,500 reads well)`);
    if (found(hook, keywords).length < 2)
      issues.push(
        'the first ~270 characters (all most people see) name fewer than 2 of your keywords',
      );
    if (!/\d/.test(hook)) issues.push('no concrete number in the first lines');
    const buzz = about.match(BUZZ);
    if (buzz)
      issues.push(`buzzwords: ${[...new Set(buzz.map((b) => b.toLowerCase()))].join(', ')}`);
    const ai = humanizerIssues(about).filter((i) => i.level === 'warn');
    if (ai.length) issues.push(`reads generic: ${ai.map((i) => i.rule).join(', ')}`);
    const germanPosts = s.posts.filter((x) => /\b(und|nicht|für|ist|wir)\b/i.test(x.text)).length;
    if (germanPosts > s.posts.length / 2 && !/\b(und|nicht|für|ist|wir)\b/i.test(about))
      issues.push('written in English while most of your posts are German');
    out.push({
      section: 'about',
      status: issues.length > 2 ? 'fail' : issues.length ? 'needs-work' : 'pass',
      note: issues.join('; ') || 'Good hook and keywords.',
    });
  }

  const current = p.experience.filter((e) => /present|heute/i.test(e.dates ?? ''));
  const withText = p.experience.filter((e) => (e.description ?? '').trim().length > 40);
  out.push({
    section: 'experience',
    status: !p.experience.length
      ? 'fail'
      : current.length && current.every((e) => (e.description ?? '').length > 40)
        ? 'pass'
        : 'needs-work',
    note: !p.experience.length
      ? 'No Experience entries were found.'
      : `${p.experience.length} entries, ${withText.length} with a description${current.some((e) => (e.description ?? '').length <= 40) ? '; your current role has no description with outcomes and keywords' : ''}.`,
  });

  if (p.url) {
    const slug = p.url.match(/\/in\/([^/]+)/)?.[1] ?? '';
    const messy = /\d{3,}|-[0-9a-f]{6,}$/i.test(slug);
    out.push({
      section: 'url',
      status: messy ? 'needs-work' : 'pass',
      note: messy
        ? `linkedin.com/in/${slug} has a random part; a clean name URL is easier to share`
        : `linkedin.com/in/${slug}`,
    });
  } else out.push({ section: 'url', status: 'unknown', note: 'Not read yet.' });

  const recent = s.posts.filter((x) => (relativeDays(x.date) ?? 999) <= 30).length;
  const recentC = s.comments.filter((x) => (relativeDays(x.date) ?? 999) <= 30).length;
  out.push({
    section: 'activity',
    status: recent >= 4 ? 'pass' : recent >= 1 ? 'needs-work' : 'fail',
    note: `${recent} posts and ${recentC} comments in the last 30 days (among those read).`,
  });
  out.push({
    section: 'featured',
    status: 'unknown',
    note: 'Not read by the robot yet; check that 2-3 of your best posts are pinned.',
  });
  out.push({
    section: 'skills',
    status: 'unknown',
    note: 'Not read by the robot yet; pin your top 3 (e.g. AI agents/automation, Zoho CRM, HubSpot).',
  });
  out.push({
    section: 'photo-banner',
    status: 'unknown',
    note: 'Images are not read; a banner with one line on what you do helps visitors.',
  });
  return out;
}

export const ProfileRewrites = z.object({
  score: z.number().int().min(0).max(100),
  priorities: z.array(z.string().max(300)).max(6),
  headline_options: z.array(z.string().max(220)).max(3),
  about: z.string().max(2600),
  current_role: z.object({ title: z.string().max(200), description: z.string().max(1500) }),
  skills_top: z.array(z.string().max(80)).max(5),
  featured_post_indexes: z.array(z.number().int().nonnegative()).max(3),
  notes: z.string().max(600),
});
export type ProfileRewrites = z.infer<typeof ProfileRewrites>;

// Rewrites may use only numbers that appear in his own texts (no invented results).
export function inventedNumbers(rewrite: string, s: VoiceSamples): string[] {
  const corpus = [
    s.profile.headline ?? '',
    s.profile.about ?? '',
    ...s.profile.experience.map((e) => `${e.title} ${e.company ?? ''} ${e.description ?? ''}`),
    ...s.posts.map((x) => x.text),
    ...s.comments.map((x) => x.text),
  ]
    .join(' ')
    .replace(/[.\s](?=\d{3}\b)/g, '');
  const nums = rewrite.replace(/[.\s](?=\d{3}\b)/g, '').match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(nums.filter((n) => !corpus.includes(n)))];
}
