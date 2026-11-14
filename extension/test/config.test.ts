import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, originPattern } from '../src/lib/config.ts';

describe('server URL', () => {
  it('accepts https anywhere and http only on localhost', () => {
    expect(normalizeServerUrl(' https://outreach.example.com/path ')).toBe(
      'https://outreach.example.com',
    );
    expect(normalizeServerUrl('http://localhost:3300')).toBe('http://localhost:3300');
    expect(() => normalizeServerUrl('http://outreach.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('not a url')).toThrow();
  });

  it('builds a port-less match pattern', () => {
    expect(originPattern('http://localhost:3300')).toBe('http://localhost/*');
    expect(originPattern('https://outreach.example.com')).toBe('https://outreach.example.com/*');
  });
});
