// Facts about a company read from its own public website (Jibran, 13.11.2026). Pure functions from HTML
// to observations: one fact per observation, each with the page it was seen on and a confidence. The
// idea (signals with evidence instead of guesses) follows the Harvey/Sellbird sales agent; the detectors
// are our own and cover German shops and offices. Page text is data, never instructions.

export interface Observation {
  code: SignalCode;
  value_text: string | null;
  value_num: number | null;
  confidence: number; // 0..1
  evidence_url: string;
}

export const SIGNALS = {
  SHOP_PLATFORM: 'Shop system (Shopify, Shopware, WooCommerce, ...)',
  SUPPORT_WHATSAPP: 'Offers WhatsApp contact',
  CHAT_WIDGET: 'Has a chat widget',
  NO_CHAT_WIDGET: 'No chat widget found on the homepage',
  CONTACT_FORM_URL: 'Contact form',
  NEWSLETTER_TOOL: 'Newsletter tool',
  TRUSTED_SHOPS: 'Trusted Shops member',
  RUNNING_ADS: 'Runs Google or Meta ads',
  CATALOG_SIZE: 'Number of product pages in the sitemap',
  BLOG_STALE: 'Days since the last blog or magazine update',
  HIRING_SUPPORT_ROLE: 'Is hiring for customer service',
  ONLINE_BOOKING: 'Offers online appointment booking',
  LEGAL_FORM: 'Legal form from the Impressum',
  OWNER_NAME: 'Owner or managing director from the Impressum',
} as const;
export type SignalCode = keyof typeof SIGNALS;

type Named = readonly [name: string, pattern: RegExp];
const first = (html: string, list: readonly Named[]) =>
  list.find(([, re]) => re.test(html))?.[0] ?? null;
const all = (html: string, list: readonly Named[]) =>
  list.filter(([, re]) => re.test(html)).map(([n]) => n);

const PLATFORMS: readonly Named[] = [
  ['Shopify', /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i],
  [
    'Shopware',
    /\/bundles\/storefront\/|\/engine\/Shopware\/|\/themes\/Frontend\/|content="Shopware/i,
  ],
  ['WooCommerce', /wp-content\/plugins\/woocommerce|woocommerce-(?:page|no-js|js)|wc-ajax=/i],
  ['Magento', /Mage\.Cookies|\/static\/version\d+\/frontend\/|Magento_[A-Z]\w+|mage\/cookies/],
  ['JTL-Shop', /JTL-Shop|\/templates\/NOVA(?:Child)?\/|\/templates\/Evo\//i],
  ['Gambio', /gambio|gm_javascript|\/templates\/Honeygrid\//i],
  ['plentymarkets', /plentymarkets|cdn\d*\.plentymarkets|plenty-shop/i],
  ['OXID', /\/out\/(?:flow|wave|azure)\/src\/|oxid-esales|OXID eShop/i],
];
const CHATS: readonly Named[] = [
  ['Userlike', /userlike-cdn|userlike\.com/i],
  ['Tidio', /code\.tidio\.co/i],
  ['Zendesk', /static\.zdassets\.com|zopim/i],
  ['Intercom', /widget\.intercom\.io|intercomSettings/i],
  ['Gorgias', /config\.gorgias\.chat|gorgias-chat/i],
  ['Superchat', /widget\.superchat\.de|superchat-widget/i],
  ['LiveChat', /cdn\.livechatinc\.com/i],
  ['Crisp', /client\.crisp\.chat/i],
  ['tawk.to', /embed\.tawk\.to/i],
  ['HubSpot chat', /js\.hs-scripts\.com|js\.usemessages\.com/i],
  ['Trengo', /static\.widget\.trengo/i],
  ['Freshchat', /wchat\.freshchat\.com/i],
];
const NEWSLETTERS: readonly Named[] = [
  ['Klaviyo', /static\.klaviyo\.com|klaviyo\.js|_learnq/i],
  ['Mailchimp', /chimpstatic\.com|list-manage\.com/i],
  ['Brevo', /sibforms\.com|sendinblue|brevo\.com/i],
  ['CleverReach', /cleverreach/i],
  ['rapidmail', /rapidmail/i],
];
const BOOKING: readonly Named[] = [
  ['Calendly', /calendly\.com/i],
  ['HubSpot Meetings', /meetings\.hubspot\.com/i],
  ['Microsoft Bookings', /outlook\.office(?:365)?\.com\/(?:owa\/calendar|book)/i],
  ['Google Kalender', /calendar\.app\.google|calendar\.google\.com\/calendar\/appointments/i],
  ['TIMIFY', /timify\.com/i],
  ['eTermin', /etermin\.net/i],
  [
    'Online-Terminbuchung',
    /online[- ]?termin(?:buchung|vereinbarung)?|termin\s+online\s+(?:buchen|vereinbaren)/i,
  ],
];
const SUPPORT_ROLE =
  /(Kundenservice|Kundenbetreuung|Kundenberat(?:er|ung)|Customer\s+(?:Support|Service|Care|Success)|Support[- ]?(?:Mitarbeiter|Agent|Specialist)|Servicemitarbeiter)[^<\n]{0,60}?\(?\s*[mwfd]\s*\/\s*[mwfd]\s*\/\s*[mwfdx]\s*\)?/i;

export interface SitePages {
  home: { url: string; html: string };
  contact?: { url: string; html: string } | null;
  careers?: { url: string; html: string } | null;
  sitemap?: { url: string; xml: string } | null;
}

export function detectSignals(p: SitePages, now = new Date()): Observation[] {
  const out: Observation[] = [];
  const add = (
    code: SignalCode,
    url: string,
    text: string | null,
    num: number | null,
    confidence: number,
  ) => out.push({ code, value_text: text, value_num: num, confidence, evidence_url: url });
  const { url, html } = p.home;

  const platform = first(html, PLATFORMS);
  if (platform) add('SHOP_PLATFORM', url, platform, null, 0.95);
  const pagesWithContact = [p.home, p.contact].filter(
    (x): x is { url: string; html: string } => !!x,
  );
  const wa = pagesWithContact.find((x) =>
    /wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send/i.test(x.html),
  );
  if (wa) add('SUPPORT_WHATSAPP', wa.url, null, 1, 0.95);
  const chats = all(html, CHATS);
  if (chats.length) add('CHAT_WIDGET', url, chats.join(', '), null, 0.95);
  // Widgets are often loaded only after cookie consent, so "none found" is a weaker fact.
  else if (html.length > 5000) add('NO_CHAT_WIDGET', url, null, 1, 0.6);
  const news = all(html, NEWSLETTERS);
  if (news.length) add('NEWSLETTER_TOOL', url, news.join(', '), null, 0.9);
  if (/widgets\.trustedshops\.com|trustedshops\.(?:de|com)\/(?:bewertung|buyerrating)/i.test(html))
    add('TRUSTED_SHOPS', url, null, 1, 0.95);
  const ads = [
    /googleadservices\.com|gtag\/js\?id=AW-|google_conversion/i.test(html) ? 'Google Ads' : null,
    /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\s*\(\s*['"]init/i.test(html) ? 'Meta' : null,
  ].filter(Boolean);
  if (ads.length) add('RUNNING_ADS', url, ads.join(', '), null, 0.9);
  const form = pagesWithContact.find((x) => /<form\b[\s\S]{0,6000}?<textarea\b/i.test(x.html));
  if (form) add('CONTACT_FORM_URL', form.url, form.url, null, 0.9);
  const booking = pagesWithContact
    .map((x) => [x.url, first(x.html, BOOKING)] as const)
    .find(([, b]) => b);
  if (booking) add('ONLINE_BOOKING', booking[0], booking[1], null, 0.8);
  if (p.careers) {
    const role = p.careers.html.replace(/<[^>]+>/g, ' ').match(SUPPORT_ROLE);
    if (role)
      add(
        'HIRING_SUPPORT_ROLE',
        p.careers.url,
        role[0].replace(/\s+/g, ' ').trim().slice(0, 120),
        null,
        0.85,
      );
  }
  if (p.sitemap) {
    const entries = [...p.sitemap.xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => ({
      loc: m[1]!.match(/<loc>\s*([^<\s]+)/i)?.[1] ?? '',
      mod: m[1]!.match(/<lastmod>\s*([^<\s]+)/i)?.[1] ?? null,
    }));
    const products = entries.filter((e) =>
      /\/(?:products?|produkte?|artikel|p|detail)\//i.test(e.loc),
    ).length;
    if (products > 0) add('CATALOG_SIZE', p.sitemap.url, null, products, 0.7);
    const blogDates = entries
      .filter((e) => e.mod && /\/(?:blog|magazin|news|ratgeber|aktuelles)\//i.test(e.loc))
      .map((e) => Date.parse(e.mod!))
      .filter((t) => Number.isFinite(t) && t <= now.getTime());
    if (blogDates.length)
      add(
        'BLOG_STALE',
        p.sitemap.url,
        null,
        Math.floor((now.getTime() - Math.max(...blogDates)) / 86_400_000),
        0.8,
      );
  }
  return out;
}

// Same-site links worth reading, found on the homepage: Impressum, contact, careers.
export function findSiteLinks(html: string, baseUrl: string) {
  const base = new URL(baseUrl);
  const links = [
    ...html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi),
  ]
    .map((m) => {
      try {
        const u = new URL(m[1]!, base);
        return {
          url: u,
          text: m[2]!
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        };
      } catch {
        return null;
      }
    })
    .filter((l): l is { url: URL; text: string } => !!l && /^https?:$/.test(l.url.protocol))
    .filter((l) => l.url.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, ''));
  const pick = (re: RegExp) => {
    const l = links.find((x) => re.test(x.text) || re.test(x.url.pathname));
    return l ? l.url.toString() : null;
  };
  return {
    impressum: pick(/\b(impressum|imprint|legal[- ]notice|anbieterkennzeichnung)\b/i),
    contact: pick(/\b(kontakt|contact)\b/i),
    careers: pick(/\b(karriere|jobs|stellenangebote|careers?|stellen)\b/i),
  };
}

// A page that is a bot check or block, not the site itself.
export const looksBlocked = (status: number, html: string) =>
  status === 403 ||
  status === 429 ||
  status === 503 ||
  /cf-challenge|Just a moment\.\.\.|Attention Required! \| Cloudflare|captcha-delivery|px-captcha|Access Denied/i.test(
    html.slice(0, 4000),
  );
