import type { AppDeps } from '../app.ts';
import { callJson } from '../db.ts';
import { domainMatchesCompany } from '@outreach/shared';
import { HttpError } from '../errors.ts';
import { getSecret } from '../secrets.ts';
import { cleanDomain } from './profile-company.ts';
import { USER_AGENT } from './public-http.ts';

// Where new companies come from (Jibran, 13.11.2026):
//  - a web search through Serper (his key from Settings, every search counted against a daily cap);
//  - OpenStreetMap for offices in a city (insurance brokers, tax advisors, property managers);
//  - the company of a lead found on LinkedIn, resolved by one search and accepted only when the
//    website's name matches the company name.
// Both services are fixed hosts called by the server; nothing a page says can change where it calls.

const SERPER_URL = 'https://google.serper.dev/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
type Fetch = typeof fetch;

// Marketplaces, directories, social networks and shop-system vendors: never a company to contact.
const NOT_A_COMPANY =
  /(^|\.)(amazon|ebay|kleinanzeigen|idealo|otto|zalando|kaufland|etsy|facebook|instagram|linkedin|xing|youtube|tiktok|pinterest|twitter|x|reddit|wikipedia|google|apple|microsoft|trustpilot|trustedshops|kununu|check24|billiger|geizhals|yelp|gelbeseiten|dasoertliche|11880|northdata|firmenwissen|bundesanzeiger|shopify|myshopify|shopware|woocommerce|wordpress|wix|jimdo|t3n|omr|statista|chip|computerbild|testberichte|ladenzeile|shopping24|provenexpert|golocal|meinestadt|cylex|wlw|europages|indeed|stepstone)\.[a-z.]+$/;

export function companyDomain(link: string): string | null {
  const d = cleanDomain(link);
  return d && !NOT_A_COMPANY.test(d) ? d : null;
}

interface Usage {
  cap: number;
  used_today: number;
  osm_recent: string[];
}
const usage = (deps: AppDeps, userId: string) =>
  callJson<Usage>(deps.db, 'ext_search_usage', [userId]);

async function serper(
  deps: AppDeps,
  userId: string,
  key: string,
  q: string,
  page: number,
  fetchImpl: Fetch,
): Promise<{ link: string; title: string }[]> {
  const res = await fetchImpl(SERPER_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q, gl: 'de', hl: 'de', num: 10, page }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403)
    throw new HttpError(
      400,
      'bad_request',
      'The web search key was not accepted. Check it in Settings.',
    );
  if (!res.ok) throw new HttpError(502, 'upstream_error', `The web search answered ${res.status}.`);
  const body = (await res.json()) as { organic?: { link?: unknown; title?: unknown }[] };
  const hits = (body.organic ?? [])
    .filter((o) => typeof o.link === 'string')
    .map((o) => ({ link: String(o.link), title: typeof o.title === 'string' ? o.title : '' }));
  await callJson(deps.db, 'ext_search_log', [userId, 'serper', q, hits.length]);
  return hits;
}

interface Added {
  found: number;
  added: number;
  known: number;
}
async function store(
  deps: AppDeps,
  userId: string,
  rows: Record<string, string | null>[],
): Promise<Added & { ids: Record<string, number> }> {
  if (!rows.length) return { found: 0, added: 0, known: 0, ids: {} };
  const r = await callJson<{ added: number; known: number; ids: Record<string, number> }>(
    deps.db,
    'ext_company_upsert',
    [userId, JSON.stringify(rows)],
  );
  return { found: rows.length, ...r };
}

// A search such as "Laufschuhe online shop": the websites in the results become companies.
export async function searchCompanies(
  deps: AppDeps,
  userId: string,
  o: { query: string; pages: number; campaign: string | null; segment: string | null },
  fetchImpl: Fetch = fetch,
): Promise<Added & { searches: number; used_today: number; cap: number }> {
  const key = await getSecret(deps, userId, 'serper_api_key');
  if (!key)
    throw new HttpError(400, 'bad_request', 'Add the web search key in Settings → Keys first.');
  const u = await usage(deps, userId);
  const room = u.cap - u.used_today;
  if (room <= 0)
    throw new HttpError(400, 'bad_request', `Today's ${u.cap} web searches are used up.`);
  const pages = Math.min(o.pages, room);
  const domains = new Map<string, string>();
  for (let page = 1; page <= pages; page++) {
    const hits = await serper(deps, userId, key, o.query, page, fetchImpl);
    for (const h of hits) {
      const d = companyDomain(h.link);
      if (d && !domains.has(d)) domains.set(d, h.title);
    }
    if (hits.length < 8) break; // no further page
  }
  const r = await store(
    deps,
    userId,
    [...domains.keys()].map((domain) => ({
      domain,
      source: 'search',
      source_ref: o.query.slice(0, 200),
      campaign_id: o.campaign,
      segment: o.segment,
    })),
  );
  const after = await usage(deps, userId);
  return {
    found: r.found,
    added: r.added,
    known: r.known,
    searches: after.used_today - u.used_today,
    used_today: after.used_today,
    cap: after.cap,
  };
}

export const OFFICE_KINDS = {
  insurance: { tag: 'insurance', label: 'Insurance brokers and agencies' },
  tax_advisor: { tag: 'tax_advisor', label: 'Tax advisors' },
  property_management: { tag: 'property_management', label: 'Property managers' },
  estate_agent: { tag: 'estate_agent', label: 'Estate agents' },
  financial_advisor: { tag: 'financial_advisor', label: 'Financial advisors' },
} as const;
export type OfficeKind = keyof typeof OFFICE_KINDS;

// Offices of one kind in one city, from OpenStreetMap. Only entries with a website are of use.
export async function findOffices(
  deps: AppDeps,
  userId: string,
  o: { city: string; kind: OfficeKind; campaign: string | null },
  fetchImpl: Fetch = fetch,
): Promise<Added & { places: number; already: boolean }> {
  const city = o.city.trim().replace(/\s+/g, ' ');
  // Letters, spaces, dots, hyphens and brackets only: the name goes into the query text.
  if (!/^[\p{L}][\p{L} .()'-]{1,60}$/u.test(city) || /["\\]/.test(city))
    throw new HttpError(400, 'bad_request', 'Enter a city name, for example Köln.');
  const label = `${o.kind}: ${city}`;
  const u = await usage(deps, userId);
  if (u.osm_recent.includes(label))
    return { found: 0, added: 0, known: 0, places: 0, already: true };
  const query = `[out:json][timeout:25];area["name"="${city}"]["boundary"="administrative"]->.a;nwr["office"="${OFFICE_KINDS[o.kind].tag}"](area.a);out tags 400;`;
  const res = await fetchImpl(OVERPASS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok)
    throw new HttpError(
      502,
      'upstream_error',
      `OpenStreetMap answered ${res.status}. Try again later.`,
    );
  const body = (await res.json()) as {
    elements?: { type?: string; id?: number; tags?: Record<string, string> }[];
  };
  const places = body.elements ?? [];
  const rows = new Map<string, Record<string, string | null>>();
  for (const p of places) {
    const t = p.tags ?? {};
    const d = companyDomain(t.website ?? t['contact:website'] ?? t.url ?? '');
    if (!d || rows.has(d)) continue;
    rows.set(d, {
      domain: d,
      name: t.name ?? null,
      source: 'osm',
      source_ref: `${p.type}/${p.id}`,
      city: t['addr:city'] ?? city,
      segment: o.kind,
      campaign_id: o.campaign,
    });
  }
  await callJson(deps.db, 'ext_search_log', [userId, 'osm', label, places.length]);
  const r = await store(deps, userId, [...rows.values()]);
  return { found: r.found, added: r.added, known: r.known, places: places.length, already: false };
}

// Leads found on LinkedIn: find the company's website with one search each. Uses at most half of the
// day's searches, so the search box always has some left.
export async function resolveLeadCompanies(
  deps: AppDeps,
  userId: string,
  max = 3,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  const key = await getSecret(deps, userId, 'serper_api_key');
  if (!key) return 0;
  const u = await usage(deps, userId);
  const room = Math.floor(u.cap / 2) - u.used_today;
  if (room <= 0) return 0;
  const leads = await callJson<
    {
      id: number;
      company: string;
      linkedin_url: string;
      campaign_id: string | null;
      segment: string | null;
    }[]
  >(deps.db, 'ext_company_resolve_next', [userId, Math.min(max, room)]);
  let linked = 0;
  for (const lead of leads) {
    try {
      const hits = await serper(deps, userId, key, lead.company, 1, fetchImpl);
      const domain = hits
        .map((h) => companyDomain(h.link))
        .find((d): d is string => !!d && domainMatchesCompany(d, lead.company));
      if (domain) {
        const r = await store(deps, userId, [
          {
            domain,
            name: lead.company,
            source: 'linkedin',
            source_ref: 'resolved by search',
            campaign_id: lead.campaign_id,
            segment: lead.segment,
          },
        ]);
        const id = r.ids[domain];
        if (id) {
          await callJson(deps.db, 'ext_company_link', [userId, id, lead.linkedin_url]);
          linked++;
        }
      }
    } catch {
      break; // key or service problem: leave the rest for later, this lead is still marked as tried
    } finally {
      await callJson(deps.db, 'ext_company_resolved', [userId, lead.id]);
    }
  }
  return linked;
}
