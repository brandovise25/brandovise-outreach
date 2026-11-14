import {
  detectSignals,
  findSiteLinks,
  looksBlocked,
  parseImpressum,
  type Impressum,
  type Observation,
} from '@outreach/shared';
import { fetchPublic, type FetchOptions, type PageResult } from './public-http.ts';

// Reads one company's public site like a visitor would: homepage, then Impressum, contact, careers and
// the sitemap (at most 6 requests, short pauses). A block page or 403/429 ends the visit for that site.

export interface CompanyProfile {
  domain: string;
  homeUrl: string | null;
  blocked: boolean;
  error: string | null;
  pages: string[];
  observations: Observation[];
  impressum: Impressum | null;
}

export function cleanDomain(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  try {
    const host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(
      /^www\./,
      '',
    );
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !/(^|\.)linkedin\.com$/.test(host)
      ? host
      : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isHtml = (r: PageResult) => r.status === 200 && /html|^$/.test(r.contentType);

export async function profileCompany(
  domainInput: string,
  opts: {
    fetch?: (url: string, o?: FetchOptions) => Promise<PageResult>;
    pauseMs?: [number, number];
    now?: Date;
  } = {},
): Promise<CompanyProfile> {
  const get = opts.fetch ?? fetchPublic;
  const [minPause, maxPause] = opts.pauseMs ?? [400, 1200];
  const pause = () => sleep(minPause + Math.random() * (maxPause - minPause));
  const domain = cleanDomain(domainInput);
  const out: CompanyProfile = {
    domain: domain ?? domainInput,
    homeUrl: null,
    blocked: false,
    error: null,
    pages: [],
    observations: [],
    impressum: null,
  };
  if (!domain) return { ...out, error: 'not a domain' };
  try {
    let home: PageResult | null = null;
    for (const start of [`https://${domain}/`, `https://www.${domain}/`]) {
      try {
        home = await get(start);
        break;
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
    }
    if (!home) return out;
    out.error = null;
    out.homeUrl = home.url;
    if (looksBlocked(home.status, home.body)) return { ...out, blocked: true };
    if (!isHtml(home)) return { ...out, error: `homepage answered ${home.status}` };
    out.pages.push(home.url);

    const links = findSiteLinks(home.body, home.url);
    const optional = async (url: string | null) => {
      if (!url || out.pages.includes(url)) return null;
      await pause();
      try {
        const r = await get(url);
        if (looksBlocked(r.status, r.body)) {
          out.blocked = true;
          return null;
        }
        if (r.status !== 200) return null;
        out.pages.push(r.url);
        return r;
      } catch {
        return null;
      }
    };
    const imp = await optional(links.impressum ?? new URL('/impressum', home.url).toString());
    const contact = out.blocked ? null : await optional(links.contact);
    const careers = out.blocked ? null : await optional(links.careers);
    const sitemap = out.blocked
      ? null
      : await optional(new URL('/sitemap.xml', home.url).toString());

    out.observations = detectSignals(
      {
        home: { url: home.url, html: home.body },
        contact: contact && { url: contact.url, html: contact.body },
        careers: careers && { url: careers.url, html: careers.body },
        sitemap:
          sitemap && /<urlset|<sitemapindex/i.test(sitemap.body)
            ? { url: sitemap.url, xml: sitemap.body }
            : null,
      },
      opts.now,
    );
    if (imp) {
      out.impressum = parseImpressum(imp.body);
      if (out.impressum.legalForm)
        out.observations.push({
          code: 'LEGAL_FORM',
          value_text: out.impressum.legalForm,
          value_num: null,
          confidence: 0.9,
          evidence_url: imp.url,
        });
      for (const p of out.impressum.people)
        out.observations.push({
          code: 'OWNER_NAME',
          value_text: `${p.name} (${p.role})`,
          value_num: null,
          confidence: 0.85,
          evidence_url: imp.url,
        });
    }
    return out;
  } catch (err) {
    return { ...out, error: err instanceof Error ? err.message : String(err) };
  }
}
