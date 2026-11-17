import { describe, expect, it } from 'vitest';
import { dueProspectSlot, insideSendWindow, leadsWaiting } from '../src/lib/auto.ts';

describe('insideSendWindow', () => {
  const week = { '1': [['09:00', '17:00']], '6': [] };
  it('follows robot_schedule like the server (0 = Sunday)', () => {
    expect(insideSendWindow(week, '2026-10-19', '10:30')).toBe(true); // Monday
    expect(insideSendWindow(week, '2026-10-19', '17:00')).toBe(false);
    expect(insideSendWindow(week, '2026-10-24', '10:30')).toBe(false); // Saturday, no window
    expect(insideSendWindow(week, '2026-10-20', '10:30')).toBe(false); // Tuesday, not listed
  });
  it('is always open without a schedule', () => {
    expect(insideSendWindow(null, '2026-10-19', '03:00')).toBe(true);
  });
});

describe('leadsWaiting', () => {
  it('counts staged leads and drafts to approve, not approved queue items', () => {
    expect(leadsWaiting({ leads: 0, approve: 0, approved: 42 })).toBe(0);
    expect(leadsWaiting({ leads: 25, approve: 20, approved: 3 })).toBe(45);
    expect(leadsWaiting(undefined)).toBe(0);
  });
  it('does not count suggested withdrawals (17.11.2026)', () => {
    // 24 leads, 37 drafts of which 36 are withdrawals: 25 wait, so prospecting runs again
    expect(leadsWaiting({ leads: 24, approve: 37, approve_contacts: 1 })).toBe(25);
  });
});

describe('dueProspectSlot', () => {
  const at = { am: '08:30', pm: '14:20' };
  const none = { am: false, pm: false };
  const T = Date.parse('2026-11-16T10:00:00Z');
  it('starts the morning round at its time and not before', () => {
    expect(dueProspectSlot('08:10', at, none, null, T)).toBeNull();
    expect(dueProspectSlot('08:31', at, none, null, T)).toBe('am');
  });
  it('runs the afternoon round after the morning one, once each', () => {
    expect(dueProspectSlot('14:30', at, { am: true, pm: false }, T - 5 * 3_600_000, T)).toBe('pm');
    expect(dueProspectSlot('14:30', at, { am: true, pm: true }, T - 5 * 3_600_000, T)).toBeNull();
  });
  it('never starts two rounds within 3 hours (Chrome came on late)', () => {
    expect(dueProspectSlot('16:30', at, none, null, T)).toBe('am');
    expect(dueProspectSlot('16:35', at, { am: true, pm: false }, T - 3 * 60_000, T)).toBeNull();
  });
  it('stops at 18:00', () => {
    expect(dueProspectSlot('18:01', at, none, null, T)).toBeNull();
  });
});
