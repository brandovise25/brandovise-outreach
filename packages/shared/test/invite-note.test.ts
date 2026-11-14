import { describe, expect, it } from 'vitest';
import { fixUmlauts, inviteNoteIssues } from '../src/invite-note.ts';

// The first notes sent on 14.11.2026, and what was wrong with them.
describe('inviteNoteIssues', () => {
  it('catches the wrong verb, grading the person and empty notes', () => {
    expect(
      inviteNoteIssues(
        'Ich baue KI-Agenten für Versicherungsmakler. Als Geschäftsführer der ProService Versicherungsmakler GmbH möchte ich Sie gern vernetzen.',
      ).join(' '),
    ).toMatch(/wrong German/);
    expect(
      inviteNoteIssues(
        'Ich baue KI-Agenten für Versicherungsmakler. Als Geschäftsführer der Einblick Versicherungsmakler GmbH passen Sie gut in mein Netzwerk.',
      ).join(' '),
    ).toMatch(/grades the person/);
    expect(
      inviteNoteIssues(
        'Ihr Profil als Versicherungsmaklerin ist mir dabei aufgefallen, ich baue KI-Agenten.',
      ).join(' '),
    ).toMatch(/grades/);
    expect(inviteNoteIssues('x').join(' ')).toMatch(/too short/);
  });
  it('accepts a plain note', () => {
    expect(
      inviteNoteIssues(
        'Sie führen die Westsachsen Versicherungsmakler GmbH. Ich baue KI-Agenten für Maklerbüros und würde mich gern mit Ihnen vernetzen.',
      ),
    ).toEqual([]);
  });
});

describe('fixUmlauts', () => {
  it('writes ordinary words with umlauts, nothing else', () => {
    expect(fixUmlauts('Inhaber von Maklerbuero Bittermann, fuer Gewerbe')).toBe(
      'Inhaber von Maklerbüro Bittermann, für Gewerbe',
    );
    expect(fixUmlauts('Treuer Kunde, Feuer, Abenteuer, Queen')).toBe(
      'Treuer Kunde, Feuer, Abenteuer, Queen',
    );
  });
});
