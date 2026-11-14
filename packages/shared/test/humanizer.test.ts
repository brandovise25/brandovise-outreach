import { describe, expect, it } from 'vitest';
import { humanizerIssues } from '../src/humanizer.ts';

const rules = (t: string) => humanizerIssues(t).map((i) => i.rule);

describe('humanizer checks', () => {
  it('passes a plain, specific comment', () => {
    expect(
      rules(
        'Der Preis pro Ergebnis zählt, nicht der Modellname, da bin ich bei Ihnen.\n\nIn Agenten-Workflows kippen die Kosten schnell, wenn jeder Schritt das größte Modell bekommt.\n\nHaben Sie Sonnet für den ersten Durchlauf getestet?',
      ),
    ).toEqual([]);
  });
  it('flags model leakage as an error', () => {
    expect(humanizerIssues('See the result oaicite here.')[0]).toMatchObject({
      level: 'error',
      rule: 'tool marker',
    });
  });
  it('flags staged constructions on one hit', () => {
    expect(rules("It's not about the tools, it's about the people.")).toContain(
      'negative parallelism',
    );
    expect(rules('Es geht nicht um Tools, sondern um Prozesse. Punkt.')).toContain(
      'negative parallelism',
    );
    expect(rules('The result? Fewer calls.')).toContain('reveal bridge');
    expect(rules('Simple. Fast. Done.')).toContain('staccato');
    expect(rules('Gute Beobachtung.\n\nWas meinen Sie?')).toContain('cliché closer');
  });
  it('a single common word is fine, a cluster is not', () => {
    expect(rules('Das ist entscheidend für kleine Büros.')).toEqual([]);
    expect(
      rules('Ein ganzheitlicher, nahtloser Ansatz ist entscheidend, um das Potenzial zu nutzen.'),
    ).toContain('AI vocabulary cluster');
  });
  it('caps em dashes instead of banning them', () => {
    expect(rules('One — is fine here.')).toEqual([]);
    expect(rules('Too — many — dashes — here.')).toContain('em dashes');
  });
});
