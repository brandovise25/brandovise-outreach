import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rulesForAction, validateDraft } from '@outreach/shared';

// The e-commerce campaign texts (migration 048, 13.11.2026) are what the robot sends in Jibran's name,
// so they must pass the same checks as any draft: length, banned phrases, Sie-form, no emoji or link,
// no question about time, nothing that reads machine-written.
const sql = readFileSync(
  resolve(import.meta.dirname, '../../db/migrations/20261113000048_ecommerce_offer.sql'),
  'utf8',
);
const up = sql.split('-- migrate:down')[0]!;
const text = (col: string) => {
  const m = up.match(new RegExp(`${col} = \\$t\\$([\\s\\S]*?)\\$t\\$`));
  if (!m) throw new Error(`${col} not found`);
  return m[1]!.replace(/_FN_/g, 'Anna');
};

describe('e-commerce campaign texts', () => {
  it('the invite note passes the invite rules (max 300 characters)', () => {
    const r = validateDraft(text('invite_note'), rulesForAction('connect'));
    expect(r.errors).toEqual([]);
    expect([...text('invite_note')].length).toBeLessThanOrEqual(300);
  });
  it.each(['msg1_text', 'msg2_text', 'msg3_text'])('%s passes the message rules', (col) => {
    expect(validateDraft(text(col), rulesForAction('message')).errors).toEqual([]);
  });
  it('covers the three offers and names no invented customer or figure', () => {
    const all = ['invite_note', 'msg1_text', 'msg2_text', 'msg3_text'].map(text).join('\n');
    expect(all).toMatch(/WhatsApp/);
    expect(all).toMatch(/Absatzprognose/);
    expect(all).toMatch(/Produktempfehlungen/);
    expect(all).not.toMatch(/\d+\s*(%|Prozent|Kunden|Händler)/);
    expect(all).not.toMatch(/Bei einem Händler/); // the old, unverified customer case
  });
});
