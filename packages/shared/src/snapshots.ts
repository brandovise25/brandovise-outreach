import { z } from 'zod';

// What the content-script adapters read from LinkedIn pages. Text only; no images, no contact data.
export const Position = z.object({
  title: z.string().max(300),
  company: z.string().max(300).nullable(),
  dates: z.string().max(120).nullable(), // as shown, e.g. "Jan 2024 - Present · 1 yr 10 mos"
  location: z.string().max(200).nullable(),
  description: z.string().max(2000).nullable(),
});
export type Position = z.infer<typeof Position>;

export const ProfileSnapshot = z.object({
  url: z.string().max(400), // normalised https://www.linkedin.com/in/<slug>/
  fullName: z.string().max(200),
  headline: z.string().max(400).nullable(),
  location: z.string().max(200).nullable(),
  degree: z.enum(['1st', '2nd', '3rd', 'out_of_network']).nullable(),
  about: z.string().max(4000).nullable(),
  experience: z.array(Position).max(15),
  actionState: z.enum(['can_connect', 'pending', 'connected', 'follow_only', 'unknown']),
  language: z.enum(['en', 'de']),
});
export type ProfileSnapshot = z.infer<typeof ProfileSnapshot>;

export const ActivityItem = z.object({
  kind: z.enum(['post', 'comment', 'repost']),
  text: z.string().max(3000),
  relativeDate: z.string().max(40).nullable(), // as shown: "3w", "2 Wo."
  url: z.string().max(500).nullable(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ActivitySnapshot = z.object({
  profileUrl: z.string().max(400),
  items: z.array(ActivityItem).max(20),
});
export type ActivitySnapshot = z.infer<typeof ActivitySnapshot>;

// Deterministic plain-text rendering. The same text is sent to the model and used for the
// verbatim-quote checks, so a quote can only pass if it really came from the page.
export function renderProfile(p: ProfileSnapshot): string {
  const lines = [`Name: ${p.fullName}`];
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.experience.length) {
    lines.push('Experience:');
    for (const e of p.experience) {
      lines.push(
        `- ${e.title}${e.company ? ` | ${e.company}` : ''}${e.dates ? ` | ${e.dates}` : ''}`,
      );
      if (e.description) lines.push(`  ${e.description}`);
    }
  }
  if (p.about) lines.push(`About: ${p.about}`);
  return lines.join('\n');
}

export function renderActivity(
  profile: ProfileSnapshot,
  activity: ActivitySnapshot | null,
): string {
  const lines = [renderProfile(profile)];
  if (activity?.items.length) {
    lines.push('Recent activity:');
    for (const a of activity.items) {
      lines.push(
        `- [${a.kind}${a.relativeDate ? `, ${a.relativeDate}` : ''}${a.url ? `, ${a.url}` : ''}] ${a.text}`,
      );
    }
  } else {
    lines.push('Recent activity: none shown');
  }
  return lines.join('\n');
}

export function normalizeProfileUrl(href: string): string | null {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    const m = decodeURIComponent(u.pathname).match(/^\/in\/([^/?#]+)/);
    return m ? `https://www.linkedin.com/in/${m[1]}/` : null;
  } catch {
    return null;
  }
}
