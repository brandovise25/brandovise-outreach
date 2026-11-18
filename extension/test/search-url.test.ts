import { describe, expect, it } from 'vitest';
import { searchUrl } from '../src/lib/prospect.ts';

describe('searchUrl', () => {
  it('is the plain people search without a location', () => {
    expect(searchUrl('Inhaber Onlineshop', 1)).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=Inhaber%20Onlineshop&origin=GLOBAL_SEARCH_HEADER',
    );
  });
  it('limits the search to LinkedIn location ids, like the location filter (18.11.2026)', () => {
    const u = new URL(searchUrl('Shopify store owner', 2, ['101165590', '104738515']));
    expect(u.searchParams.get('keywords')).toBe('Shopify store owner');
    expect(JSON.parse(u.searchParams.get('geoUrn')!)).toEqual(['101165590', '104738515']);
    expect(u.searchParams.get('origin')).toBe('FACETED_SEARCH');
    expect(u.searchParams.get('page')).toBe('2');
  });
});
