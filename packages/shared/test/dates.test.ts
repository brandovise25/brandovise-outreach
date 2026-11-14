import { describe, expect, it } from 'vitest';
import { maxAgeDays, triggerFresh } from '../src/dates.ts';

describe('maxAgeDays', () => {
  it('uses the upper bound of LinkedIn relative dates (en + de)', () => {
    expect(maxAgeDays('3w')).toBe(27);
    expect(maxAgeDays('3 Wo.')).toBe(27);
    expect(maxAgeDays('2 months ago')).toBe(89);
    expect(maxAgeDays('vor 5 Tagen')).toBe(5);
    expect(maxAgeDays('1 J.')).toBe(729);
    expect(maxAgeDays('8h')).toBe(0);
    expect(maxAgeDays('Edited')).toBeNull();
  });
});

describe('triggerFresh', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('applies per-type max ages', () => {
    expect(triggerFresh('post', { relative: '5w' }, now)).toBe(true); // up to 41 days
    expect(triggerFresh('post', { relative: '6w' }, now)).toBe(false); // up to 48 days > 45
    expect(triggerFresh('role_change', { iso: '2026-08-01' }, now)).toBe(true);
    expect(triggerFresh('company_news', { iso: '2026-07-01' }, now)).toBe(false);
  });
  it('allows only events to be in the future', () => {
    expect(triggerFresh('shared_event', { iso: '2026-10-20' }, now)).toBe(true);
    expect(triggerFresh('post', { iso: '2026-10-20' }, now)).toBe(false);
    expect(triggerFresh('none', { iso: '2026-10-08' }, now)).toBe(false);
  });
});
