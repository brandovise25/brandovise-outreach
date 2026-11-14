import { describe, expect, it } from 'vitest';
import { cleanCompany, distinctiveTokens, mentionsAny } from '../src/prepare.ts';

// The 5 invites held back on 14.11.2026 although their notes named the person's business.
const c = (company: string | null, headline: string, evidence: string[] = []) => ({
  company,
  headline,
  fit: { evidence },
});

describe('what an invite note must mention', () => {
  it('ignores the kind of employment LinkedIn adds to the company', () => {
    expect(cleanCompany('suitedbusinesspartners · Self-employed')).toBe('suitedbusinesspartners');
    expect(cleanCompany('Selbstständig · Self-employed')).toBe('');
  });
  it('accepts notes that name the business in the facts or headline', () => {
    const marvin = c(
      'Selbstständig · Self-employed',
      'Freier Finanzmakler - Ehrlich. Unabhängig. Auf Augenhöhe.',
    );
    expect(
      mentionsAny(
        'Seit April 2025 sind Sie als freier Finanzmakler selbstständig, unabhängig und auf Augenhöhe.',
        distinctiveTokens(marvin),
      ),
    ).toBe(true);
    const tobias = c(
      'suitedbusinesspartners · Self-employed',
      'Gründer und Geschäftsführer von suited. business partners',
    );
    expect(
      mentionsAny(
        'Mit suited. business partners betreuen Sie Privat- und Geschäftskunden.',
        distinctiveTokens(tobias),
      ),
    ).toBe(true);
    const unger = c(
      'Business Netzwerk Leichlingen BNL · Part-time',
      'Ihr Makler für Firmen und Gewerbe',
      ['Inhaber | Prime Versicherungsmakler'],
    );
    expect(
      mentionsAny(
        'Mit Prime Versicherungsmakler beraten Sie vor allem Firmen und Gewerbe.',
        distinctiveTokens(unger),
      ),
    ).toBe(true);
  });
  it('still holds back a note with nothing about the person', () => {
    const t = distinctiveTokens(c('Aventus Versicherungsmakler Augsburg GmbH', 'Geschäftsführer'));
    expect(
      mentionsAny('Sie sind Versicherungsmakler. Ich baue KI-Agenten für Maklerbüros.', t),
    ).toBe(false);
    expect(distinctiveTokens(c(null, 'Finanzmakler', ['Headline: Finanzmakler']))).toEqual([]);
  });
});
