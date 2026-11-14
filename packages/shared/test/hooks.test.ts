import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYBOOK,
  ungivenNumbers,
  parsePlaybook,
  pickHook,
  scanPhrase,
} from '../src/hooks.ts';

const rules = parsePlaybook(DEFAULT_PLAYBOOK);
const sig = (
  code: string,
  value_text: string | null = null,
  value_num: number | null = null,
  confidence = 0.95,
) => ({
  code,
  value_text,
  value_num,
  confidence,
  evidence_url: 'https://shop.example/',
});
const SHOP = 'ecommerce-first-level-support';

describe('playbook', () => {
  it('parses sections, conditions and hints and skips broken lines', () => {
    expect(rules.length).toBe(8);
    expect(rules[1]).toMatchObject({
      campaign: SHOP,
      angle: 'support',
      conditions: [
        { code: 'SUPPORT_WHATSAPP', absent: false },
        { code: 'NO_CHAT_WIDGET', absent: false },
      ],
    });
    expect(parsePlaybook('nonsense\nFOO =>\n[x]\n!AA + BB>=3 => Angle | say b')).toEqual([
      {
        campaign: 'x',
        angle: 'angle',
        hint: 'say b',
        conditions: [
          { code: 'AA', absent: true, min: null },
          { code: 'BB', absent: false, min: 3 },
        ],
      },
    ]);
  });
});

describe('pickHook', () => {
  it('takes the first matching rule of the campaign', () => {
    const h = pickHook(
      [
        sig('SHOP_PLATFORM', 'Shopify'),
        sig('SUPPORT_WHATSAPP', null, 1),
        sig('NO_CHAT_WIDGET', null, 1, 0.6),
      ],
      rules,
      SHOP,
    );
    expect(h).toMatchObject({
      code: 'SUPPORT_WHATSAPP',
      angle: 'support',
      tokens: ['whatsapp'],
      platform: 'Shopify',
    });
  });
  it('leads with forecast for a large range, and never states the number', () => {
    const h = pickHook(
      [sig('SHOP_PLATFORM', 'Shopware'), sig('CATALOG_SIZE', null, 1200, 0.7)],
      rules,
      SHOP,
    );
    expect(h).toMatchObject({ code: 'SHOP_PLATFORM', angle: 'forecast', tokens: ['Shopware'] });
    expect(h!.fact).not.toMatch(/\d/);
    expect(
      pickHook([sig('SHOP_PLATFORM', 'Shopware'), sig('CATALOG_SIZE', null, 80, 0.7)], rules, SHOP),
    ).toMatchObject({ angle: 'support' });
  });
  it('uses the general rules for other campaigns and nothing without a usable signal', () => {
    expect(pickHook([sig('ONLINE_BOOKING', 'Calendly', null, 0.8)], rules, 'makler')).toMatchObject(
      { angle: 'office' },
    );
    expect(pickHook([sig('SHOP_PLATFORM', 'Shopify')], rules, 'makler')).toBeNull();
    expect(
      pickHook([sig('NO_CHAT_WIDGET', null, 1, 0.6), sig('LEGAL_FORM', 'GmbH')], rules, SHOP),
    ).toBeNull();
    expect(pickHook([sig('SUPPORT_WHATSAPP', null, 1, 0.5)], rules, SHOP)).toBeNull();
    expect(pickHook([], rules, SHOP)).toBeNull();
    expect(pickHook(null, rules, SHOP)).toBeNull();
  });
});

describe('text checks', () => {
  it('finds wording that sounds like an audit', () => {
    expect(scanPhrase('Ich habe Ihre Website analysiert und drei Punkte gefunden.')).toBeTruthy();
    expect(scanPhrase('Ihren Shop habe ich mir genauer untersucht.')).toBeTruthy();
    expect(
      scanPhrase('Ihr Shop läuft auf Shopify, und Kunden erreichen Sie per WhatsApp.'),
    ).toBeNull();
  });
  it('finds numbers that were not given', () => {
    expect(ungivenNumbers('Über 1200 Artikel und 24 Stunden', 'seit 24 Jahren')).toEqual(['1200']);
    expect(ungivenNumbers('Ohne Zahl', '')).toEqual([]);
  });
});
