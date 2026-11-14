import { describe, expect, it } from 'vitest';
import { compareVersions, isVersionAllowed } from '../src/version.ts';

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });

  it('gates on minimum version', () => {
    expect(isVersionAllowed('0.1.0', '0.1.0')).toBe(true);
    expect(isVersionAllowed('0.0.9', '0.1.0')).toBe(false);
  });
});
