import { describe, expect, it } from 'vitest';
import {
  factCheckComment,
  pausedAuthor,
  pickCommentShape,
  postKey,
  repeatIssues,
  shapeInstructions,
  validateComment,
} from '../src/feed.ts';

const good =
  'Genau da setzt es an: Die Meldung ist selten das Problem, sondern das Zuordnen zum richtigen Vertrag im MVP.\n\nWie viele der Mails landen bei Ihnen heute schon ohne Handarbeit in der richtigen Akte, und wo hakt es am häufigsten?';

describe('validateComment', () => {
  it('accepts a comment that follows the engagement rules', () => {
    expect(validateComment(good)).toMatchObject({ ok: true });
  });
  it('rejects blocks, hashtags, links, CTA, the agency name and generic endings', () => {
    const bad = validateComment(
      'Super Beitrag #KI von Brandovise, schreib mir gern: www.x.de. Was denkt ihr?',
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        'contains a hashtag',
        'contains a link',
        'names Brandovise',
        'contains a call to action',
        'generic closing question',
      ]),
    );
  });
});

describe('comment shapes', () => {
  it('accepts a one-line kudos and a short comment without paragraphs', () => {
    expect(validateComment('Bravo, Lea, 61 Anwahlen an einem Tag!', [], 'kudos').ok).toBe(true);
    expect(
      validateComment(
        'Die Grenze für die Freigabe im Config-Node statt im Prompt zu halten, macht den Ablauf wartbar.',
        [],
        'short',
      ).ok,
    ).toBe(true);
  });
  it('keeps a valid draft that ignores its shape, with a warning', () => {
    const k = validateComment(good, [], 'kudos');
    expect(k.ok).toBe(true);
    expect(k.warnings.join(' ')).toMatch(/kudos shape/);
    expect(
      validateComment('Wie lange hat der Umbau der Freigabe gedauert, Mawa.', [], 'question')
        .warnings,
    ).toContain('question shape without a question');
  });
  it('still needs paragraphs for long comments', () => {
    expect(validateComment('Wort '.repeat(60).trim()).errors).toContain(
      'not split into paragraphs',
    );
  });
  it('rejects the stock phrases of the first posted comments', () => {
    const t =
      'Erst der Prozess, dann die Automatisierung.\n\nDie Frage nach den manuellen Schritten ist stark, weil sie die Grenze festlegt.';
    expect(validateComment(t).errors.join(' ')).toMatch(/stock phrase/);
  });
  it('draws every shape and tells the AI which post gets which', () => {
    const seq = [0.05, 0.3, 0.5, 0.9];
    const shapes = seq.map((r) => pickCommentShape(() => r));
    expect(shapes).toEqual(['kudos', 'short', 'question', 'standard']);
    expect(shapeInstructions(shapes)).toMatch(/\[0\] KUDOS[\s\S]*\[3\] STANDARD/);
  });
});

describe('closing question', () => {
  it('rejects a question to the audience', () => {
    const t =
      'Das Bild mit der Platine trifft es: Qualität zeigt sich dort, wo der Kunde nie hinschaut, auch im Backoffice.\n\nBei den Maklerbüros, mit denen wir arbeiten, steckt die Zeit im Übertragen zwischen Postfach und Verwaltungsprogramm.\n\nWo hakt es bei euch häufiger: beim Dateneingang oder bei der Freigabe?';
    expect(validateComment(t).errors).toContain(
      'closing question asks the audience, not the author',
    );
  });
});

describe('postKey', () => {
  it('prefers the URN and is stable otherwise', () => {
    expect(postKey({ urn: 'urn:li:activity:1', author: 'A', text: 'x' })).toBe('urn:li:activity:1');
    const a = postKey({ urn: null, author: 'Anna  Wagner', text: 'Hallo   Welt' });
    expect(a).toBe(postKey({ urn: null, author: 'anna wagner', text: 'hallo welt' }));
    expect(a).not.toBe(postKey({ urn: null, author: 'anna wagner', text: 'andere welt' }));
  });
});

describe('factCheckComment', () => {
  const post = 'Wir haben 30 % mehr Schadenmeldungen und 2 Kolleginnen im Innendienst.';
  const ok =
    'Bei 30 % mehr Meldungen ist das Zuordnen der eigentliche Engpass, nicht die Meldung selbst.\n\nWie verteilen die 2 Kolleginnen die Fälle heute untereinander, nach Sparte oder nach Eingang?';
  it('passes when every number is from the post', () => {
    expect(factCheckComment(ok, post)).toEqual([]);
  });
  it('flags invented numbers', () => {
    expect(factCheckComment(ok.replace('30 %', '45 %'), post)).toContain(
      'number(s) not in the post: 45',
    );
  });
});

describe('number check on a post cut at 600 characters', async () => {
  const { factCheckComment } = await import('../src/feed.ts');
  const comment =
    'Das 24-Stunden-Fenster ist der Teil, auf den ich achten würde, weil dort jede Freigabe mit Grund protokolliert werden sollte.\n\nIn kleinen Büros zeigen genau diese Gründe, was die Prüfung noch übersieht.\n\nWelchen Grund erwarten Sie am häufigsten?';
  it('does not block a number that may sit after the cut', () => {
    expect(factCheckComment(comment, 'x'.repeat(600))).not.toContainEqual(
      expect.stringMatching(/number/),
    );
  });
  it('still blocks it when the full post is known', () => {
    expect(factCheckComment(comment, 'Ein kurzer Beitrag ohne Zahlen.')).toContainEqual(
      expect.stringMatching(/number/),
    );
  });
});

describe('pausedAuthor', () => {
  const p = (author: string, authorProfile: string | null) => ({
    author,
    authorHeadline: null,
    authorProfile,
    authorFollowers: null,
    text: 'x',
    relativeDate: null,
    reactions: null,
    comments: null,
    media: 'none' as const,
    promoted: false,
    urn: null,
    url: null,
  });
  const paused = [
    {
      name: 'Lena Bauer',
      profile: 'https://www.linkedin.com/in/lea-bosch-12/?mini=1',
      status: 'posted',
      at: '2026-10-20',
    },
    { name: 'Advanivo', profile: null, status: 'approved', at: '2026-10-19' },
  ];
  it('matches by profile path, ignoring case and query', () => {
    expect(
      pausedAuthor(p('Lea B.', 'https://www.linkedin.com/in/Lea-Bosch-12'), paused)?.status,
    ).toBe('posted');
  });
  it('falls back to the name when a profile is missing', () => {
    expect(
      pausedAuthor(p('Advanivo', 'https://www.linkedin.com/company/advanivo/'), paused)?.status,
    ).toBe('approved');
  });
  it('does not match a different person with the same name but another profile', () => {
    expect(
      pausedAuthor(p('Lena Bauer', 'https://www.linkedin.com/in/lea-bosch-99/'), paused),
    ).toBeNull();
  });
});

describe('repeatIssues', () => {
  const kfz =
    'Beim automatisierten Kfz-Vergleich ohne manuelle Eingabe lag die meiste Arbeit im Vertragsbestand.';
  it('allows the own example once among open and recent comments', () => {
    expect(repeatIssues(kfz, ['Daten zuerst, dann der Agent.'])).toEqual([]);
    expect(
      repeatIssues('Den Kfz-Vergleich, den ich gebaut habe, speist der Bestand.', [kfz]),
    ).toEqual(['own example (Kfz-Vergleich) is already in another open or recent comment']);
  });
  it('flags a run of five words copied from another comment, ignoring case and punctuation', () => {
    expect(
      repeatIssues('Hier fehlt meist die Regel, wann er an einen Menschen übergibt.', [
        'Meist fehlt die Regel: Wann er an einen Menschen übergibt, ist offen.',
      ]),
    ).toEqual(['repeats "die regel wann er an" from another open or recent comment']);
    expect(
      repeatIssues('In kleinen Büros zählt die Ablage.', ['Aus kleinen Büros kenne ich das.']),
    ).toEqual([]);
  });
  it('bans the "deckt sich mit meiner/meinem" opener', () => {
    expect(
      validateComment('Kurt, das deckt sich mit meinem Bild aus kleinen Büros und der Ablage.')
        .errors,
    ).toContain('stock phrase: "deckt sich mit meinem"');
  });
});

describe('factCheckComment numbers', () => {
  const post = 'Jobs sagte 1992, er frage zuerst, wie die Person lernt.';
  it('ignores digits inside words like n8n, B2B or 3D', () => {
    expect(
      factCheckComment(
        'Beim Bauen mit n8n und im B2B-Vertrieb mit 3D-Modellen zeigt sich das schnell.',
        post,
      ),
    ).not.toContainEqual(expect.stringMatching(/number/));
  });
  it('still flags a standalone figure that is not in the post', () => {
    expect(
      factCheckComment('Das spart 8 Stunden pro Woche, wie 1992 schon klar war.', post),
    ).toContainEqual('number(s) not in the post: 8');
  });
});
