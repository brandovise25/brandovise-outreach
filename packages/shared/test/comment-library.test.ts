import { describe, expect, it } from 'vitest';
import {
  DRAFTING_HARD_LIMITS,
  commentSetStats,
  examplesBlock,
  guessLang,
  opensWithName,
  replaceDraftingSection,
} from '../src/comment-library.ts';

describe('comment study helpers', () => {
  it('spots comments that open with the post author’s first name', () => {
    expect(opensWithName('Rena, 2/3 Annahme zeigt …', 'Rena Gerlach')).toBe(true);
    expect(opensWithName('Hallo Sandra, zu den Rechten …', 'Sandra Tewes')).toBe(true);
    expect(opensWithName('Kenne ich genau so.', 'Sandra Tewes')).toBe(false);
    expect(opensWithName('Dr. Kurt hat recht', 'Dr. Kurt Wendler')).toBe(true);
  });
  it('measures length, questions, emoji and address form', () => {
    const s = commentSetStats([
      { text: 'Kenne ich 😅', postAuthor: 'A B', lang: 'de' },
      { text: 'Wie lösen Sie das im Bestand?', postAuthor: 'A B', lang: 'de' },
      { text: 'Great point, thanks for sharing.', postAuthor: 'A B', lang: 'en' },
    ]);
    expect(s.n).toBe(3);
    expect(s.share).toMatchObject({
      question: 0.33,
      emoji: 0.33,
      sie: 0.33,
      english: 0.33,
      oneParagraph: 1,
    });
    expect(s.chars.median).toBe(29);
  });
  it('guesses the language', () => {
    expect(guessLang('Das ist genau der Punkt, und bei uns auch.')).toBe('de');
    expect(guessLang('This is the point and we see it too.')).toBe('en');
    expect(guessLang('👍')).toBe('');
  });
  it('replaces only the DRAFTING section and always appends the hard limits', () => {
    const rules =
      'ADMISSION: x\n\nDRAFTING (old):\n- 200-350 characters.\nMARKETING LEVEL: 0 = pure\n';
    const out = replaceDraftingSection(
      rules,
      'DRAFTING:\n- Answer the question first.\n- 40-160 characters.',
    )!;
    expect(out).toMatch(/^ADMISSION: x/);
    expect(out).toMatch(/- Answer the question first\./);
    expect(out).not.toMatch(/200-350/);
    expect(out).toContain(DRAFTING_HARD_LIMITS);
    expect(out).toMatch(/MARKETING LEVEL: 0 = pure/);
    expect(replaceDraftingSection('no sections here', 'x')).toBeNull();
  });
  it('builds no style block from an empty library', () => {
    expect(examplesBlock({ good: [], bad: [], liked: [] })).toBe('');
  });
});
