// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMoreComments, readPostComments } from '../src/lib/adapters/post-comments.ts';

// Shape of LinkedIn's comment component as captured 09.10.2026 (names and texts invented).
const comment = (post: string, id: string, name: string, text: string, extra = '') => `
<div componentkey="CommentComponentReference_urn:li:comment:(activity:${post},${id})">
  <a href="https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, '-')}/?mini=1"><p><span>${name} • 2nd</span></p><p><span>Makler in Hamburg</span></p></a>
  <button aria-label="View more options for ${name}’s comment."></button>
  <p><span data-testid="expandable-text-box">${text}<button data-testid="expandable-text-button">… more</button></span></p>
  <span>4 reactions</span>
  ${extra}
</div>`;

describe('readPostComments', () => {
  it('reads author, text, likes and replies; a reply is not part of its parent', () => {
    document.body.innerHTML = `<main>${comment(
      '1',
      '11',
      'Anna Beispiel',
      'Kenne ich. Bei uns hat erst die Checkliste geholfen.',
      comment(
        '1',
        '12',
        'Bert Muster',
        '<span><a href="/in/anna-beispiel/"><strong>Anna Beispiel</strong></a></span> Genau so!',
      ),
    )}<button>Load more comments</button></main>`;
    const cs = readPostComments(document);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({
      author: 'Anna Beispiel',
      text: 'Kenne ich. Bei uns hat erst die Checkliste geholfen.',
      reactions: 4,
      reply: false,
      profile: 'https://www.linkedin.com/in/anna-beispiel/',
      headline: 'Makler in Hamburg',
    });
    expect(cs[1]).toMatchObject({
      author: 'Bert Muster',
      text: 'Genau so!',
      reply: true,
      mentions: 'Anna Beispiel',
    });
    expect(loadMoreComments(document)).toBe(true);
  });

  const raw = resolve(
    import.meta.dirname,
    '../../fixtures/raw/activity/linkedin-raw-activity-en-2026-10-09T09-49-36.html',
  );
  it.skipIf(!existsSync(raw))('reads the raw activity comments capture (local only)', () => {
    document.documentElement.innerHTML = readFileSync(raw, 'utf8').replace(
      /^<!doctype html>\s*/i,
      '',
    );
    const cs = readPostComments(document);
    expect(cs.length).toBeGreaterThan(10);
    expect(cs.every((c) => c.author && c.text)).toBe(true);
    expect(cs.some((c) => c.reply && c.mentions)).toBe(true);
  });
});
