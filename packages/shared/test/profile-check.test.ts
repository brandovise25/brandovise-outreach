import { describe, expect, it } from 'vitest';
import { inventedNumbers, profileFindings, relativeDays } from '../src/profile-check.ts';
import type { VoiceSamples } from '../src/voice.ts';

const s: VoiceSamples = {
  profile: {
    name: 'Test',
    headline: 'He/Him',
    about: 'We unlock the transformative power of cutting-edge AI for businesses everywhere.',
    url: 'https://www.linkedin.com/in/test-person-1a2b3c4d5/',
    experience: [
      {
        title: 'Founder',
        company: 'Brandovise GmbH',
        dates: 'Jan 2024 - Present',
        description: null,
      },
    ],
  },
  posts: [
    { text: 'Wir haben 75 Versicherer gerechnet und das ist für Makler wichtig.', date: '2w' },
    { text: 'Noch ein Beitrag für Makler und Zoho.', date: '3mo' },
  ],
  comments: [{ text: 'Genau so.', on: null, date: '3d' }],
};

describe('profile check findings', () => {
  const f = Object.fromEntries(profileFindings(s).map((x) => [x.section, x]));
  it('flags a pronoun-only headline without keywords', () => {
    expect(f.headline!.status).toBe('fail');
    expect(f.headline!.note).toMatch(/pronouns/);
  });
  it('flags a generic English About under German posts', () => {
    expect(f.about!.status).toBe('fail');
    expect(f.about!.note).toMatch(/buzzwords/);
    expect(f.about!.note).toMatch(/English/);
  });
  it('flags a current role without description, a messy URL, and counts recent posts', () => {
    expect(f.experience!.status).toBe('needs-work');
    expect(f.url!.status).toBe('needs-work');
    expect(f.activity!.note).toMatch(/^1 posts and 1 comments/);
    expect(relativeDays('1mo')).toBe(30);
  });
  it('finds numbers that are not in his texts', () => {
    expect(inventedNumbers('KFZ-Vergleich über 75 Versicherer', s)).toEqual([]);
    expect(inventedNumbers('40 % mehr Abschlüsse', s)).toEqual(['40']);
  });
});
