import { describe, expect, it } from 'vitest';
import { cleanFirstName, parseKillWords, salutation } from '../src/salutation.ts';

const killWords = parseKillWords('bsn, ceo, dr, mba, phd, expert, seo');
const killChars = '.,★☆✪☁📍💪🏼🎖🏼📦♦➤✔✓~()"\'';

describe('cleanFirstName', () => {
  it('strips titles, emoji and kill characters', () => {
    expect(cleanFirstName('Dr. Anna', killWords, killChars)).toBe('Anna');
    expect(cleanFirstName('🚀 Jens ✔', killWords, killChars)).toBe('Jens');
    expect(cleanFirstName('ANNA-LENA', killWords, killChars)).toBe('Anna-Lena');
  });
  it('refuses company names and empty results', () => {
    expect(cleanFirstName('Müller Versicherungen GmbH', killWords, killChars)).toBeNull();
    expect(cleanFirstName('CEO', killWords, killChars)).toBeNull();
    expect(cleanFirstName('', killWords, killChars)).toBeNull();
  });
});

describe('salutation', () => {
  it('never guesses Herr/Frau', () => {
    expect(salutation('Anna')).toBe('Guten Tag Anna,');
    expect(salutation(null)).toBe('Guten Tag,');
  });
});
