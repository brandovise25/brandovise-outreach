import { describe, expect, it } from 'vitest';
import { cleanProfileUrls } from '../src/lib/import-leads.ts';

describe('cleanProfileUrls', () => {
  it('keeps personal profile links once, without tracking parameters', () => {
    expect(
      cleanProfileUrls(
        'https://www.linkedin.com/in/Anna-Muster/?miniProfileUrn=abc\nhttps://de.linkedin.com/in/anna-muster\nhttps://www.linkedin.com/in/ben-b/overlay/',
      ),
    ).toEqual(['https://www.linkedin.com/in/anna-muster', 'https://www.linkedin.com/in/ben-b']);
  });
  it('ignores company pages, posts and other sites', () => {
    expect(
      cleanProfileUrls([
        'https://www.linkedin.com/company/acme/',
        'https://www.linkedin.com/feed/update/urn:li:activity:1/',
        'https://example.com/in/someone',
        'not a link',
      ]),
    ).toEqual([]);
  });
  it('takes at most 10 links', () => {
    const many = Array.from({ length: 15 }, (_, i) => `https://www.linkedin.com/in/person-${i}/`);
    expect(cleanProfileUrls(many)).toHaveLength(10);
  });
});
