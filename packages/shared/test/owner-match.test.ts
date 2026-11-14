import { describe, expect, it } from 'vitest';
import { companyWords, domainMatchesCompany, ownerMatch } from '../src/owner-match.ts';

describe('company names', () => {
  it('keeps the distinctive words', () => {
    expect(companyWords('Laufshop Müller GmbH & Co. KG')).toEqual(['laufshop', 'mueller']);
    expect(companyWords('Online Shop GmbH')).toEqual([]);
  });
  it('accepts a website only when it carries the name', () => {
    expect(domainMatchesCompany('laufshop-mueller.de', 'Laufshop Müller GmbH')).toBe(true);
    expect(domainMatchesCompany('laufsport-beispiel.de', 'laufsport-beispiel.de GmbH')).toBe(true);
    expect(domainMatchesCompany('sportwelt.de', 'Laufshop Müller GmbH')).toBe(false);
    expect(domainMatchesCompany('shop.de', 'Online Shop GmbH')).toBe(false);
  });
});

describe('ownerMatch', () => {
  const company = { name: 'Laufshop Müller GmbH', domain: 'laufshop-mueller.de' };
  const card = (name: string, headline: string | null, snippet: string | null = null) => ({
    name,
    headline,
    snippet,
  });
  it('finds the owner by name and company', () => {
    const people = [
      card('Tobias Merten', 'Vertrieb bei Autohaus Schmidt'),
      card(
        'Dr. Tobias Merten',
        'Geschäftsführer',
        'Current: Geschäftsführer at Laufshop Müller GmbH',
      ),
      card('Tina Müller', 'Inhaberin Laufshop'),
    ];
    expect(ownerMatch(people, 'Tobias Merten', company)).toBe(1);
    expect(ownerMatch(people, 'Dipl.-Kfm. Tobias Merten', company)).toBe(1);
  });
  it('gives no one when the company is not mentioned, the name differs or two people fit', () => {
    expect(ownerMatch([card('Tobias Merten', 'Geschäftsführer')], 'Tobias Merten', company)).toBe(
      -1,
    );
    expect(ownerMatch([card('Thomas Meier', 'Inhaber Laufshop')], 'Tobias Merten', company)).toBe(
      -1,
    );
    expect(
      ownerMatch(
        [card('Tobias Merten', 'Inhaber Laufshop'), card('Tobias Merten', 'Laufshop Müller')],
        'Tobias Merten',
        company,
      ),
    ).toBe(-1);
    expect(ownerMatch([card('Tobias Merten', 'Inhaber Laufshop')], 'Müller', company)).toBe(-1);
    expect(ownerMatch([], 'Tobias Merten', company)).toBe(-1);
  });
  it('uses the domain when the company has no name', () => {
    expect(
      ownerMatch([card('Rolf Schenk', 'Gründer laufsport-beispiel.de')], 'Rolf Schenk', {
        name: null,
        domain: 'laufsport-beispiel.de',
      }),
    ).toBe(0);
  });
});
