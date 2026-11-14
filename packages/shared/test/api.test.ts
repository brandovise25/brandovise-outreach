import { describe, expect, it } from 'vitest';
import { Limits, LoginRequest } from '../src/api.ts';

describe('API contract', () => {
  it('rejects a login without a device id', () => {
    expect(LoginRequest.safeParse({ email: 'a@b.de', password: 'x' }).success).toBe(false);
  });

  it('keeps unknown columns from outreach.limits()', () => {
    const parsed = Limits.parse({
      invite_status: 'open',
      invites_allowed_now: 3,
      messages_allowed_now: 10,
      invites_resume_at: null,
      daily_invites_used: 2,
    });
    expect(parsed.daily_invites_used).toBe(2);
  });
});
