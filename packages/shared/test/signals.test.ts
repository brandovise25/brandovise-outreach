import { describe, expect, it } from 'vitest';
import { detectSignals, findSiteLinks, looksBlocked } from '../src/signals.ts';
import { parseImpressum } from '../src/impressum.ts';

const pad = '<p>'.padEnd(6000, 'x') + '</p>';
const codes = (html: string, extra = {}) =>
  Object.fromEntries(
    detectSignals(
      { home: { url: 'https://shop.example/', html: html + pad }, ...extra },
      new Date('2026-11-13'),
    ).map((o) => [o.code, o.value_text ?? o.value_num]),
  );

describe('detectSignals', () => {
  it('names the shop system', () => {
    expect(codes('<script src="https://cdn.shopify.com/s/x.js">').SHOP_PLATFORM).toBe('Shopify');
    expect(codes('<link href="/bundles/storefront/assets/a.css">').SHOP_PLATFORM).toBe('Shopware');
    expect(codes('<body class="woocommerce-no-js">').SHOP_PLATFORM).toBe('WooCommerce');
    expect(codes('<p>ein Blog über Shops</p>').SHOP_PLATFORM).toBeUndefined();
  });
  it('sees WhatsApp, chat widgets, newsletter tools, ads and Trusted Shops', () => {
    const c = codes(
      '<a href="https://wa.me/4917012345">WhatsApp</a><script src="https://userlike-cdn-widgets.s3.eu-west-1.amazonaws.com/x.js"></script><script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script><script>fbq("init","1")</script><script src="https://widgets.trustedshops.com/js/X.js"></script>',
    );
    expect(c).toMatchObject({
      SUPPORT_WHATSAPP: 1,
      CHAT_WIDGET: 'Userlike',
      NEWSLETTER_TOOL: 'Klaviyo',
      RUNNING_ADS: 'Meta',
      TRUSTED_SHOPS: 1,
    });
    expect(c.NO_CHAT_WIDGET).toBeUndefined();
  });
  it('says "no chat widget" only as a weak fact on a real page', () => {
    const o = detectSignals({ home: { url: 'https://a.example/', html: pad } }).find(
      (x) => x.code === 'NO_CHAT_WIDGET',
    );
    expect(o?.confidence).toBeLessThan(0.7);
    expect(detectSignals({ home: { url: 'https://a.example/', html: '<p>short</p>' } })).toEqual(
      [],
    );
  });
  it('reads catalogue size and blog age from the sitemap, and a support job from the careers page', () => {
    const xml = `<urlset>${'<url><loc>https://shop.example/products/a</loc></url>'.repeat(120)}<url><loc>https://shop.example/blog/x</loc><lastmod>2026-08-05</lastmod></url></urlset>`;
    const c = codes('', {
      sitemap: { url: 'https://shop.example/sitemap.xml', xml },
      careers: {
        url: 'https://shop.example/jobs',
        html: '<h3>Mitarbeiter Kundenservice (m/w/d)</h3>',
      },
      contact: {
        url: 'https://shop.example/kontakt',
        html: '<form action="/send"><textarea name="msg"></textarea></form>',
      },
    });
    expect(c.CATALOG_SIZE).toBe(120);
    expect(c.BLOG_STALE).toBe(100);
    expect(c.HIRING_SUPPORT_ROLE).toMatch(/Kundenservice \(m\/w\/d\)/);
    expect(c.CONTACT_FORM_URL).toBe('https://shop.example/kontakt');
  });
  it('finds Impressum, contact and careers links on the same site only', () => {
    const l = findSiteLinks(
      '<a href="/impressum">Impressum</a><a href="https://other.example/kontakt">Kontakt</a><a href="/pages/kontakt">Kontakt</a><a href="/karriere"><span>Jobs</span></a>',
      'https://www.shop.example/',
    );
    expect(l).toEqual({
      impressum: 'https://www.shop.example/impressum',
      contact: 'https://www.shop.example/pages/kontakt',
      careers: 'https://www.shop.example/karriere',
    });
  });
  it('recognises a block page', () => {
    expect(looksBlocked(403, '')).toBe(true);
    expect(looksBlocked(200, '<title>Just a moment...</title>')).toBe(true);
    expect(looksBlocked(200, '<title>Mein Shop</title>')).toBe(false);
  });
});

describe('parseImpressum', () => {
  it('reads the managing directors, legal form and register', () => {
    const r = parseImpressum(
      '<h1>Impressum</h1><p>Muster Sport GmbH<br>Hauptstraße 5<br>80331 München</p><p>Geschäftsführer: Dr. Max Mustermann, Anna-Lena von Berg</p><p>Registergericht: Amtsgericht München<br>Registernummer: HRB 123 456</p><p>Telefon: 089 123</p>',
    );
    expect(r.people).toEqual([
      { name: 'Max Mustermann', role: 'Geschäftsführer' },
      { name: 'Anna-Lena von Berg', role: 'Geschäftsführer' },
    ]);
    expect(r).toMatchObject({
      legalForm: 'GmbH',
      register: 'HRB 123456',
      court: 'Amtsgericht München',
    });
  });
  it('reads a sole owner whose name stands on the next line', () => {
    const r = parseImpressum(
      '<div>Tierbedarf Lange e.K.</div><div>Inhaberin</div><div>Sabine Lange</div><div>Telefon 0221 5</div>',
    );
    expect(r.people).toEqual([{ name: 'Sabine Lange', role: 'Inhaberin' }]);
    expect(r.legalForm).toBe('e.K.');
  });
  it('follows "vertreten durch ... Geschäftsführer" and skips company names', () => {
    const r = parseImpressum(
      '<p>Kaffee Kontor GmbH &amp; Co. KG, vertreten durch die Kaffee Kontor Verwaltungs GmbH, diese vertreten durch den Geschäftsführer Jörg Petersen</p>',
    );
    expect(r.people.map((p) => p.name)).toEqual(['Jörg Petersen']);
    expect(r.legalForm).toBe('GmbH & Co. KG');
  });
  it('returns nobody rather than a wrong name', () => {
    expect(
      parseImpressum(
        '<p>Verantwortlich für den Inhalt: die Redaktion. Sitz der Gesellschaft: Berlin</p>',
      ).people,
    ).toEqual([]);
  });
});
