import { useState } from 'react';
import { openTab, panelPost } from './api.ts';
import { embedded } from './bridge.ts';
import { startJob, waitForJob } from './robot.tsx';
import { useData, type Campaign } from './views.tsx';

// Companies and their signals: facts read from a company's own website (shop system, WhatsApp, chat,
// owner from the Impressum, ...). Shown on leads, used to pick the opening of a message, and as a filter.

export interface Signal {
  code: string;
  label: string;
  category: string;
  value_text: string | null;
  value_num: number | null;
  confidence: number;
  evidence_url: string | null;
}

export function SignalChips({ signals }: { signals: Signal[] | null | undefined }) {
  if (!signals?.length) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
      {signals.map((s, i) => (
        <a
          key={i}
          className="badge"
          href={s.evidence_url ?? '#'}
          title={`Seen on ${s.evidence_url ?? 'the site'}${s.confidence < 0.7 ? ' (uncertain)' : ''}`}
          style={{ opacity: s.confidence < 0.7 ? 0.6 : 1, textDecoration: 'none' }}
          onClick={(e) => (e.preventDefault(), openTab(s.evidence_url))}
        >
          {s.label}
          {s.value_text
            ? `: ${s.value_text}`
            : s.value_num !== null && s.value_num !== 1
              ? `: ${s.value_num}`
              : ''}
        </a>
      ))}
    </div>
  );
}

interface CompanyRow {
  id: number;
  domain: string;
  name: string | null;
  source: string;
  profile_status: 'ok' | 'blocked' | 'error' | null;
  profile_error: string | null;
  lookup_status: string | null;
  signals: Signal[];
  leads: number;
}
interface CompanyList {
  counts: Record<string, number>;
  codes: { code: string; label: string; category: string; companies: number }[];
  items: CompanyRow[];
}

interface SearchUsage {
  cap: number;
  used_today: number;
  has_key: boolean;
  office_kinds: Record<string, { label: string }>;
}
type Source = 'paste' | 'search' | 'offices';

export function Companies({
  refreshKey,
  toast,
  onLeads,
}: {
  refreshKey: number;
  toast: (m: string) => void;
  onLeads?: () => void;
}) {
  const [codes, setCodes] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const { data, reload } = useData<CompanyList>(
    `/panel/companies?codes=${codes.join(',')}`,
    refreshKey + tick,
  );
  const { data: usage, reload: reloadUsage } = useData<SearchUsage>(
    '/panel/companies/search-usage',
    refreshKey,
  );
  const { data: campaigns } = useData<Campaign[]>('/panel/campaigns', 0);
  const [source, setSource] = useState<Source>('paste');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState(1);
  const [city, setCity] = useState('');
  const [kind, setKind] = useState('insurance');
  const [campaign, setCampaign] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      toast(await fn());
      reload();
      reloadUsage();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const summary = (r: { added: number; known: number }) =>
    `${r.added} compan${r.added === 1 ? 'y' : 'ies'} added${r.known ? `, ${r.known} already known` : ''}. Their sites are read in the background.`;
  const add = () =>
    act('Adding…', async () => {
      const r = await panelPost<{ added: number; known: number }>('/panel/companies', {
        text,
        campaign: campaign || null,
      });
      setText('');
      return summary(r);
    });
  const search = () =>
    act('Searching…', async () => {
      const r = await panelPost<{ added: number; known: number; used_today: number; cap: number }>(
        '/panel/companies/search',
        { query, pages, campaign: campaign || null },
      );
      return `${summary(r)} ${r.used_today} of ${r.cap} searches used today.`;
    });
  const offices = () =>
    act('Asking OpenStreetMap…', async () => {
      const r = await panelPost<{ added: number; known: number; places: number; already: boolean }>(
        '/panel/companies/offices',
        { city, kind, campaign: campaign || null },
      );
      return r.already
        ? 'This city was already searched in the last 7 days.'
        : `${r.places} offices found, ${r.added} with a website added${r.known ? `, ${r.known} already known` : ''}.`;
    });
  const assign = () =>
    act('Saving…', async () => {
      const r = await panelPost<{ changed: number }>('/panel/companies/campaign', { campaign });
      return `${r.changed} companies now belong to this campaign.`;
    });
  // The robot searches the owners on LinkedIn and puts them into Leads (nothing is sent).
  const lookup = async () => {
    setBusy('Queued…');
    try {
      const id = await startJob('company_lookup', { max: 5 });
      const r = await waitForJob(id, setBusy, 60 * 60_000);
      toast(r.message || r.status);
      reload();
      onLeads?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const c = data?.counts;
  const n = (k: string) => c?.[k] ?? 0;
  const toLookUp = n('to_look_up');
  const tab = (id: Source, label: string) => (
    <button className={`btn ${source === id ? 'primary' : ''}`} onClick={() => setSource(id)}>
      {label}
    </button>
  );
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Companies</h2>
        <button className="btn" onClick={() => (setOpen((v) => !v), setTick((t) => t + 1))}>
          {open ? 'Hide' : `Show${n('all') ? ` (${n('all')})` : ''}`}
        </button>
      </div>
      <div className="muted small">
        Start from the company: the app reads each website (shop system, WhatsApp and chat, the
        owner from the Impressum). The robot then looks the owner up on LinkedIn and lists the
        person below for your approval. Nothing is sent from here.
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {tab('paste', 'Paste websites')}
        {tab('search', 'Web search')}
        {tab('offices', 'Offices in a city')}
      </div>
      {source === 'paste' && (
        <textarea
          rows={3}
          placeholder="shop-beispiel.de (one per line, or a CSV)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {source === 'search' &&
        (usage && !usage.has_key ? (
          <div className="small">
            Web search needs a key: Settings → Keys → Web search key (Serper). The first 2,500
            searches are free.
          </div>
        ) : (
          <>
            <input
              placeholder='What a customer would search, e.g. "Laufschuhe online shop"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="muted small">
              Marketplaces and directories are left out.{' '}
              {usage ? `${usage.used_today} of ${usage.cap} searches used today.` : ''}
            </div>
          </>
        ))}
      {source === 'offices' && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input
            placeholder="City, e.g. Köln"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            style={{ flex: 1, minWidth: 120 }}
          />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(
              usage?.office_kinds ?? { insurance: { label: 'Insurance brokers' } },
            ).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">Campaign (needed for the owner lookup)</option>
          {(campaigns ?? [])
            .filter((x) => x.status === 'on')
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
        {source === 'paste' && (
          <button
            className="btn primary"
            disabled={!!busy || !text.trim()}
            onClick={() => void add()}
          >
            Add companies
          </button>
        )}
        {source === 'search' && (
          <>
            <select value={pages} onChange={(e) => setPages(Number(e.target.value))}>
              <option value={1}>10 results (1 search)</option>
              <option value={2}>20 results (2 searches)</option>
              <option value={3}>30 results (3 searches)</option>
            </select>
            <button
              className="btn primary"
              disabled={!!busy || query.trim().length < 3 || !usage?.has_key}
              onClick={() => void search()}
            >
              Search
            </button>
          </>
        )}
        {source === 'offices' && (
          <button
            className="btn primary"
            disabled={!!busy || city.trim().length < 2}
            onClick={() => void offices()}
          >
            Find offices
          </button>
        )}
      </div>
      {busy && <div className="small">{busy}</div>}
      {n('all') > 0 && (
        <div className="small muted">
          {n('all')} companies · {n('profiled')} read · {n('waiting')} waiting · {n('blocked')} not
          readable · {n('with_owner')} with an owner name · {n('looked_up')} looked up on LinkedIn
        </div>
      )}
      {n('all') > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {embedded && (
            <button
              className="btn"
              disabled={!!busy || toLookUp <= 0}
              onClick={() => void lookup()}
            >
              Look up owners on LinkedIn
              {toLookUp > 0 ? ` (${Math.min(5, toLookUp)} of ${toLookUp})` : ''}
            </button>
          )}
          {n('no_campaign') > 0 && (
            <button className="btn" disabled={!!busy || !campaign} onClick={() => void assign()}>
              Use the chosen campaign for {n('no_campaign')} without one
            </button>
          )}
        </div>
      )}
      {open && data && (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {data.codes
              .filter((x) => x.companies > 0)
              .map((x) => (
                <button
                  key={x.code}
                  className={`btn ${codes.includes(x.code) ? 'primary' : ''}`}
                  title="Show only companies with this signal"
                  onClick={() =>
                    setCodes((cur) =>
                      cur.includes(x.code) ? cur.filter((y) => y !== x.code) : [...cur, x.code],
                    )
                  }
                >
                  {x.label} {x.companies}
                </button>
              ))}
          </div>
          {data.items.map((co) => (
            <div
              key={co.id}
              className="stack"
              style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 6 }}
            >
              <div className="row between small">
                <a
                  href={`https://${co.domain}`}
                  onClick={(e) => (e.preventDefault(), openTab(`https://${co.domain}`))}
                >
                  <b>{co.name ?? co.domain}</b>
                </a>
                <span className="muted">
                  {co.profile_status === null
                    ? 'waiting to be read'
                    : co.profile_status === 'ok'
                      ? `${co.leads} lead${co.leads === 1 ? '' : 's'}${co.lookup_status ? ` · LinkedIn: ${co.lookup_status.replace('_', ' ')}` : ''}`
                      : (co.profile_error ?? co.profile_status)}
                </span>
              </div>
              <SignalChips signals={co.signals} />
            </div>
          ))}
          {!data.items.length && <div className="small muted">No companies match.</div>}
        </>
      )}
    </div>
  );
}

// Leads by what their company's website shows ("Shopify + WhatsApp + no chat").
export function SignalFilter({
  leads,
  value,
  onChange,
}: {
  leads: { signals?: Signal[] }[];
  value: string[];
  onChange: (codes: string[]) => void;
}) {
  const seen = new Map<string, { label: string; n: number }>();
  for (const l of leads)
    for (const s of l.signals ?? []) {
      const e = seen.get(s.code) ?? { label: s.label, n: 0 };
      e.n++;
      seen.set(s.code, e);
    }
  if (!seen.size) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
      <span className="small muted">Company shows:</span>
      {[...seen.entries()].map(([code, e]) => (
        <button
          key={code}
          className={`btn ${value.includes(code) ? 'primary' : ''}`}
          onClick={() =>
            onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code])
          }
        >
          {e.label} {e.n}
        </button>
      ))}
    </div>
  );
}
export const hasSignals = (lead: { signals?: Signal[] }, codes: string[]) =>
  codes.every((c) => (lead.signals ?? []).some((s) => s.code === c));

// A key that is entered once and never shown again (stored encrypted on the server).
export function SecretField({
  name,
  label,
  help,
  toast,
}: {
  name: string;
  label: string;
  help: string;
  toast: (m: string) => void;
}) {
  const { data, reload } = useData<Record<string, { hint: string | null; updated_at: string }>>(
    '/panel/secrets',
    0,
  );
  const [value, setValue] = useState('');
  const save = async (v: string) => {
    try {
      await panelPost(`/panel/secrets/${name}`, { value: v });
      setValue('');
      reload();
      toast(v ? `${label} saved.` : `${label} removed.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const cur = data?.[name];
  return (
    <div className="stack">
      <div className="small">
        <b>{label}</b>{' '}
        <span className="muted">{cur ? `set (ends in ${cur.hint ?? '…'})` : 'not set'}</span>
      </div>
      <div className="muted small">{help}</div>
      <div className="row" style={{ gap: 6 }}>
        <input
          type="password"
          autoComplete="off"
          placeholder={cur ? 'Enter a new key to replace it' : 'Paste the key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button className="btn primary" disabled={!value.trim()} onClick={() => void save(value)}>
          Save
        </button>
        {cur && (
          <button className="btn" onClick={() => confirm(`Remove the ${label}?`) && void save('')}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

// How each opening did: which website fact an invite or a first message referred to.
interface OpeningStat {
  kind: 'invite' | 'first_message';
  campaign_id: string | null;
  hook: string;
  angle: string;
  platform: string;
  sent: number;
  accepted: number;
  replied: number;
}
const MIN_SENDS = 20; // below this a difference says nothing

export function OpeningStats({ campaign }: { campaign: string }) {
  const { data } = useData<OpeningStat[]>('/panel/message-stats', 0);
  const rows = (data ?? []).filter((r) => r.campaign_id === campaign);
  if (!rows.some((r) => r.hook !== 'none')) return null;
  // one line per kind and fact (shop systems added up)
  const merged = new Map<string, OpeningStat>();
  for (const r of rows) {
    const key = `${r.kind}|${r.hook}|${r.angle}`;
    const m = merged.get(key);
    if (m) {
      m.sent += r.sent;
      m.accepted += r.accepted;
      m.replied += r.replied;
    } else merged.set(key, { ...r });
  }
  const list = [...merged.values()];
  const rate = (r: OpeningStat) =>
    (r.kind === 'invite' ? r.accepted : r.replied) / Math.max(1, r.sent);
  const best = (kind: OpeningStat['kind']) => {
    const enough = list.filter((r) => r.kind === kind && r.sent >= MIN_SENDS);
    return enough.length > 1 ? enough.reduce((a, b) => (rate(b) > rate(a) ? b : a)) : null;
  };
  const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : '–');
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Openings</h2>
      <div className="muted small">
        What each message opened with, last 120 days. A line is marked once two openings have{' '}
        {MIN_SENDS} sends each; nothing changes by itself.
      </div>
      <table className="small" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th>Opened with</th>
            <th>Offer</th>
            <th>Sent</th>
            <th>Accepted</th>
            <th>Replied</th>
          </tr>
        </thead>
        <tbody>
          {(['invite', 'first_message'] as const).flatMap((kind) =>
            list
              .filter((r) => r.kind === kind)
              .sort((a, b) => b.sent - a.sent)
              .map((r) => (
                <tr key={`${kind}${r.hook}${r.angle}`}>
                  <td>
                    {kind === 'invite' ? 'Invite' : 'First message'}:{' '}
                    {r.hook === 'none' ? 'profile only' : r.hook.toLowerCase().replace(/_/g, ' ')}
                    {best(kind) === r && <span className="badge"> better so far</span>}
                  </td>
                  <td>{r.angle || '–'}</td>
                  <td>{r.sent}</td>
                  <td>{kind === 'invite' ? pct(r.accepted, r.sent) : '–'}</td>
                  <td>{pct(r.replied, r.sent)}</td>
                </tr>
              )),
          )}
        </tbody>
      </table>
    </div>
  );
}
