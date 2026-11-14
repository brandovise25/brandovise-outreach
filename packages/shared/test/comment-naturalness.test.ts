import { describe, expect, it } from 'vitest';
import { praiseVerdict, repeatIssues, validateComment } from '../src/feed.ts';

// 14.11.2026: comments read as AI because they restated the post as praise and repeated the same
// n8n story. Texts below are the real drafts that were rejected.
describe('praise that restates the post', () => {
  it('is caught in English and German', () => {
    for (const t of [
      'Kariaki, tools that only offer truly free slots is the right call for a voice agent.',
      'Tanvir, getting more out of existing GPUs before buying bigger ones is the right engineering priority.',
      'Martin, OcuLink für die externe GPU ist das Detail, das den M5 Max für lokale Inferenz interessant macht.',
      'Ait, "Wir nehmen jeden mit, in seinem Tempo" ist ein ehrliches Versprechen an Makler.',
      'Dominic, gut eingeordnet: Tempo durch MCP, aber Zugriffsrechte bleiben beim Menschen.',
      'Hira, die Frage, wem der KI-Kontext gehört, ist genau die richtige.',
      'Congrats, Tassilo. The update reaching existing OS9 cars is the part that counts.',
    ]) {
      expect(praiseVerdict(t), t).not.toBeNull();
      expect(validateComment(t).errors.join(' '), t).toMatch(/restates the post as praise/);
    }
  });
  it('leaves comments that add something alone', () => {
    for (const t of [
      'Ein Vier-Augen-Prinzip lässt sich als Freigabe-Workflow abbilden: Eine Zahlung geht erst raus, wenn eine zweite Person bestätigt hat.',
      'Julian, bei Tipp 4: Landen die Notizen aus dem Selbst-Chat später automatisch in deinem Second Brain, oder sortierst du sie von Hand?',
      'Keeping Gmail in draft mode means a wrong reply never reaches a customer. What does the Switch node do with an inquiry that fits none of your routes?',
      'If the human gets the full chat history attached, the customer does not have to repeat everything. That is the right moment to hand over.',
    ])
      expect(praiseVerdict(t), t).toBeNull();
  });
});

describe('the own n8n story', () => {
  it('may appear once among open and recent comments, in any language', () => {
    const earlier = [
      "I've worked with n8n for over a year, first on hobby projects, then for clients.",
    ];
    expect(
      repeatIssues(
        'Kenne ich: bei mir waren es erst Hobby-Workflows in n8n, nach über einem Jahr dann die ersten Kundenprojekte.',
        earlier,
      ).join(' '),
    ).toMatch(/own n8n story/);
    expect(repeatIssues('In n8n I keep the limit in a config node.', earlier)).toEqual([]);
    expect(
      repeatIssues('After over a year with n8n, the real work sits between the nodes.', []),
    ).toEqual([]);
  });
});
