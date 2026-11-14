import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CommentLibrary } from './library.tsx';
import { RepliesInbox } from './replies.tsx';
import {
  Companies,
  OpeningStats,
  SignalChips,
  SignalFilter,
  hasSignals,
  type Signal,
} from './companies.tsx';
import { rulesForAction, validateDraft } from '@outreach/shared';
import { ago, openTab, panelGet, panelPost } from './api.ts';
import { askExtension, embedded } from './bridge.ts';
import { startJob, waitForJob } from './robot.tsx';

// ---------- shared bits ----------

export function useData<T>(path: string, refreshKey: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    panelGet<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [path]);
  useEffect(load, [load, refreshKey]);
  return { data, error, reload: load };
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="card empty">{children}</div>;
}

function Loading({ error }: { error: string | null }) {
  return error ? (
    <div className="card error">{error}</div>
  ) : (
    <div className="card empty">Loading…</div>
  );
}

interface Fit {
  status?: 'yes' | 'no' | 'unsure';
  reason?: string;
  evidence?: string[];
}
interface Trigger {
  type?: string;
  note?: string;
  url?: string;
}

function FitBadge({ fit }: { fit: Fit | null }) {
  if (!fit?.status) return <span className="badge">fit: not checked</span>;
  const cls = fit.status === 'yes' ? 'ok' : fit.status === 'no' ? 'bad' : 'warn';
  return (
    <span className={`badge ${cls}`} title={fit.reason}>
      fit: {fit.status === 'unsure' ? '❓' : fit.status}
    </span>
  );
}

function TriggerChip({ trigger }: { trigger: Trigger | null }) {
  if (!trigger?.type || trigger.type === 'none')
    return <span className="badge warn">no trigger</span>;
  return (
    <span className="badge ok" title={trigger.note}>
      {trigger.type.replace('_', ' ')}
    </span>
  );
}

// ---------- Today ----------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Dashboard {
  limits: {
    invite_status: string;
    invites_allowed_now: number;
    invites_today: number;
    daily_invite_cap: number;
    invites_this_week: number;
    weekly_invite_cap: number;
    messages_today: number;
    daily_message_cap: number;
    pending_invites: number;
    pending_invite_cap: number;
    invites_resume_at: string | null;
  };
  ai: { today_usd: number; week_usd: number; budget_usd: number };
  counts: {
    approve: number;
    approved: number;
    leads: number;
    comments: number;
    replies_open: number;
  };
  runs: { id: number; kind: string; status: string; started_at: string; notes: string | null }[];
}

function Stat({ label, value, of }: { label: string; value: number | string; of?: number }) {
  const pct =
    of && typeof value === 'number' ? Math.min(100, Math.round((value / of) * 100)) : null;
  return (
    <div className="stat">
      <div className="v">
        {value}
        {of !== undefined && <span className="muted small"> / {of}</span>}
      </div>
      <div className="l">{label}</div>
      {pct !== null && (
        <div className="bar">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

const INVITE_STATUS: Record<string, string> = {
  open: 'Invites open',
  daily_cap: 'Daily invite cap reached',
  weekly_cap: 'Weekly invite cap reached',
  linkedin_warning: 'Paused after a LinkedIn warning',
  paused_until: 'Invites paused',
  pending_cap: 'Too many pending invites',
  pending_unknown: 'Waiting for a fresh pending-invites count',
  robot_paused: 'Robot paused',
};

function SyncNow() {
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    try {
      const id = await startJob('sync_round');
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus);
      setStatus(r.message || r.status);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Sync with LinkedIn</h2>
        <button
          className="btn"
          disabled={!!status && !/Synced|error|stopped/i.test(status)}
          onClick={() => void run()}
        >
          Sync now
        </button>
      </div>
      <div className="muted small">
        Reads your recent connections, sent invitations and inbox list (about 2 minutes, threads are
        not opened): who accepted, who replied, how many invites are pending. Automatic every 25–40
        minutes when switched on in Settings.
      </div>
      {status && <div className="small">{status}</div>}
    </div>
  );
}

export function Today({ refreshKey, onGo }: { refreshKey: number; onGo: (tab: string) => void }) {
  const { data, error } = useData<Dashboard>('/panel/dashboard', refreshKey);
  if (!data) return <Loading error={error} />;
  const l = data.limits;
  const open = l.invite_status === 'open';
  return (
    <>
      {embedded && <SyncNow />}
      <div className="card">
        <div className="row between">
          <span className={`pill ${open ? 'ok' : 'warn'}`}>
            {INVITE_STATUS[l.invite_status] ?? l.invite_status}
          </span>
          {l.invites_resume_at && (
            <span className="muted small">
              until {new Date(l.invites_resume_at).toLocaleString('de-DE')}
            </span>
          )}
        </div>
        {l.invite_status === 'pending_cap' && (
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            {l.pending_invites} invites are still pending (cap {l.pending_invite_cap}). Withdrawals
            bring the number down.
          </p>
        )}
      </div>
      <div className="stats">
        <Stat label="Invites today" value={l.invites_today} of={l.daily_invite_cap} />
        <Stat label="Invites last 7 days" value={l.invites_this_week} of={l.weekly_invite_cap} />
        <Stat label="Messages today" value={l.messages_today} of={l.daily_message_cap} />
        <Stat label="Pending invites" value={l.pending_invites} of={l.pending_invite_cap} />
      </div>
      <div className="card">
        <h2>Waiting for you</h2>
        <div className="stack">
          {[
            [
              'approve',
              `${data.counts.approve} to approve`,
              `${data.counts.approved} approved, waiting to send`,
            ],
            ['leads', plural(data.counts.leads, 'new lead', 'new leads'), 'staged by prospecting'],
            [
              'comments',
              plural(data.counts.comments, 'comment draft', 'comment drafts'),
              'you post them yourself',
            ],
            [
              'approve',
              plural(data.counts.replies_open, 'open reply', 'open replies'),
              'people who wrote back',
            ],
          ].map(([tab, a, b]) => (
            <button
              key={a}
              className="btn"
              style={{ textAlign: 'left', borderRadius: 8 }}
              onClick={() => onGo(tab!)}
            >
              <span className="name">{a}</span> <span className="muted small">· {b}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>AI spend</h2>
          <span className="muted small">budget ${Number(data.ai.budget_usd).toFixed(2)}/day</span>
        </div>
        <div className="row" style={{ gap: 16, marginTop: 6 }}>
          <span>
            today <b>${Number(data.ai.today_usd).toFixed(3)}</b>
          </span>
          <span>
            7 days <b>${Number(data.ai.week_usd).toFixed(3)}</b>
          </span>
        </div>
      </div>
      <div className="card">
        <h2>Recent runs</h2>
        {data.runs.length === 0 && <p className="muted small">No runs yet.</p>}
        {data.runs.map((r) => (
          <div key={r.id} className="row between small" style={{ padding: '3px 0' }}>
            <span>
              <span
                className={`badge ${r.status === 'ok' ? 'ok' : r.status === 'running' ? '' : 'warn'}`}
              >
                {r.status}
              </span>{' '}
              {r.kind}
            </span>
            <span className="muted">{ago(r.started_at)} ago</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Approve ----------

interface QueueRow {
  id: number;
  action: string;
  step: number | null;
  status: 'proposed' | 'approved';
  message_text: string | null;
  campaign_id: string | null;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  linkedin_url: string;
  reply_snippet: string | null;
  reply_outcome?: string | null;
  reply_reason?: string | null;
  fit: Fit | null;
  trigger: Trigger | null;
}

const ACTION_LABEL: Record<string, string> = {
  connect: 'Invite',
  message: 'Message',
  reply: 'Reply',
  withdraw: 'Withdraw',
  inmail: 'InMail',
};

function QueueCard({ row, onDone }: { row: QueueRow; onDone: (msg: string) => void }) {
  const [text, setText] = useState(row.message_text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isInvite = row.action === 'connect';
  const hasText = row.action !== 'withdraw';
  const check = hasText && text ? validateDraft(text, rulesForAction(row.action)) : null;
  const len = [...text].length;

  const decide = async (decision: 'approve' | 'reject' | 'later') => {
    setBusy(true);
    setError(null);
    try {
      await panelPost(`/panel/queue/${row.id}`, { decision, text: hasText ? text : null });
      onDone(
        decision === 'approve'
          ? 'Approved. It will be sent in send mode.'
          : decision === 'reject'
            ? 'Rejected.'
            : 'Moved back.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <div className="row between">
        <span className="name">
          <a
            href={row.linkedin_url}
            onClick={(e) => (e.preventDefault(), openTab(row.linkedin_url))}
          >
            {row.full_name ?? row.linkedin_url}
          </a>
        </span>
        <span className="badge">
          {ACTION_LABEL[row.action] ?? row.action}
          {row.step ? ` · step ${row.step}` : ''}
        </span>
      </div>
      <div className="muted small clip">
        {[row.headline, row.company].filter(Boolean).join(' · ')}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <FitBadge fit={row.fit} />
        {isInvite && <TriggerChip trigger={row.trigger} />}
        {row.status === 'approved' && <span className="badge ok">approved</span>}
        {row.campaign_id && <span className="badge">{row.campaign_id}</span>}
      </div>
      {row.fit?.reason && <div className="quote">{row.fit.reason}</div>}
      {isInvite && row.trigger?.note && <div className="quote">Trigger: {row.trigger.note}</div>}
      {row.action === 'reply' && row.reply_snippet && (
        <div className="quote">They wrote: {row.reply_snippet}</div>
      )}
      {row.action === 'reply' && row.reply_reason && (
        <div className="muted small">
          Sorted as {(row.reply_outcome ?? 'reply').replace('_', ' ')}: {row.reply_reason}
        </div>
      )}
      {hasText && (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={isInvite ? 'No note (connect without a note)' : ''}
          />
          <div className={`count ${isInvite && len > 300 ? 'over' : ''}`}>
            {len}
            {isInvite ? ' / 300' : ''}
          </div>
          {check && !check.ok && <div className="error">{check.errors.join(' · ')}</div>}
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="actions">
        {row.status === 'proposed' && (
          <button
            className="btn primary"
            disabled={busy || (check !== null && !check.ok)}
            onClick={() => void decide('approve')}
          >
            Approve
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void decide('later')}>
          Later
        </button>
        <button className="btn danger" disabled={busy} onClick={() => void decide('reject')}>
          Reject
        </button>
      </div>
    </div>
  );
}

// What each kind of approval means, in plain words.
const GROUPS: { id: string; label: string; actions: string[]; explain: string }[] = [
  {
    id: 'connect',
    label: 'Invites',
    actions: ['connect'],
    explain:
      'Connection requests to new people. Check the fit and the note (built on a real trigger). Approve = it may be sent in send mode.',
  },
  {
    id: 'message',
    label: 'Follow-ups',
    actions: ['message', 'inmail'],
    explain:
      'Campaign messages to people who accepted. Before sending, the conversation is re-read: if they wrote back, the message is skipped.',
  },
  {
    id: 'reply',
    label: 'Replies',
    actions: ['reply'],
    explain: 'Answers to people who wrote back. Read their message, edit the draft, then approve.',
  },
  {
    id: 'withdraw',
    label: 'Withdrawals',
    actions: ['withdraw'],
    explain:
      'Withdraw invites that have been pending too long (over 30 days). This brings the pending count down so new invites are allowed again.',
  },
];

function SendApproved({ refreshKey, toast }: { refreshKey: number; toast: (m: string) => void }) {
  const { data, reload } = useData<{
    items: { action: string; full_name: string | null }[];
    practice: boolean;
    paused: boolean;
    window_open: boolean;
    stale: number;
  }>('/panel/send/preview', refreshKey);
  const [status, setStatus] = useState<string | null>(null);
  if (!data) return null;
  const by = (a: string) => data.items.filter((i) => i.action === a).length;
  const summary = [
    by('reply') && `${by('reply')} repl${by('reply') === 1 ? 'y' : 'ies'}`,
    by('message') && `${by('message')} message${by('message') === 1 ? '' : 's'}`,
    by('withdraw') && `${by('withdraw')} withdrawal${by('withdraw') === 1 ? '' : 's'}`,
    by('connect') && `${by('connect')} invite${by('connect') === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');
  const run = async () => {
    const what = data.practice
      ? `PRACTICE run: ${summary}. Everything is typed and checked, then cancelled. Nothing is sent.`
      : `SEND NOW: ${summary}. This really sends on LinkedIn, 40-120 s apart.`;
    if (!confirm(what)) return;
    try {
      const id = await startJob('send_round');
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus, 40 * 60_000);
      setStatus(null);
      reload();
      toast(r.message || r.status);
    } catch (e) {
      setStatus(null);
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Send approved</h2>
        <span className={`pill ${data.practice ? 'ok' : 'bad'}`}>
          {data.practice ? 'Practice (dry run)' : 'Live'}
        </span>
      </div>
      <div className="small">
        {data.paused
          ? 'The robot is paused (Settings).'
          : !data.window_open
            ? 'Outside your send times (Settings). Nothing goes out now.'
            : data.items.length
              ? `Next round (max 5): ${summary}.`
              : 'Nothing approved and due within your limits.'}
      </div>
      {data.stale > 0 && (
        <div className="muted small">
          {data.stale} approved item{data.stale === 1 ? ' is' : 's are'} older than 14 days and
          skipped, so nothing outdated is sent. Approve them again if they are still right.
        </div>
      )}
      <div className="actions">
        <button
          className="btn primary"
          disabled={!data.items.length || !!status}
          onClick={() => void run()}
        >
          {data.practice ? 'Practice send' : 'Send approved'}
        </button>
      </div>
      {status && <div className="small">{status}</div>}
    </div>
  );
}

export function Approve({ refreshKey, toast }: { refreshKey: number; toast: (m: string) => void }) {
  const { data, error, reload } = useData<QueueRow[]>('/panel/queue', refreshKey);
  const [group, setGroup] = useState<string | null>(null);
  const [showApproved, setShowApproved] = useState(false);
  // Due invites and follow-ups are prepared on the server (personal note, checks); then the list is reloaded.
  useEffect(() => {
    let off = false;
    panelPost('/panel/queue/prepare', {})
      .then(() => !off && reload())
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [refreshKey]);
  if (!data) return <Loading error={error} />;
  if (!data.length)
    return (
      <>
        {embedded && <SendApproved refreshKey={refreshKey} toast={toast} />}
        <RepliesInbox refreshKey={refreshKey} toast={toast} onChanged={reload} />
        <Empty>
          Nothing to approve. Due invites and follow-up messages appear here, prepared and checked.
        </Empty>
      </>
    );
  const count = (g: (typeof GROUPS)[number], status: string) =>
    data.filter((r) => g.actions.includes(r.action) && r.status === status).length;
  const active =
    GROUPS.find((g) => g.id === group) ??
    GROUPS.find((g) => count(g, 'proposed') > 0) ??
    GROUPS[0]!;
  const rows = data.filter((r) => active.actions.includes(r.action));
  const proposed = rows.filter((r) => r.status === 'proposed');
  const approved = rows.filter((r) => r.status === 'approved');

  return (
    <>
      {embedded && <SendApproved refreshKey={refreshKey} toast={toast} />}
      <RepliesInbox refreshKey={refreshKey} toast={toast} onChanged={reload} />
      <div className="card stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {GROUPS.map((g) => {
            const n = count(g, 'proposed');
            const a = count(g, 'approved');
            return (
              <button
                key={g.id}
                className={`btn ${g.id === active.id ? 'primary' : ''}`}
                onClick={() => setGroup(g.id)}
                title={`${n} to approve, ${a} approved`}
              >
                {g.label} {n > 0 ? n : ''}
                {a > 0 && <span className="muted small"> · {a}✓</span>}
              </button>
            );
          })}
        </div>
        <div className="muted small">{active.explain}</div>
      </div>

      {active.actions.includes('withdraw') && proposed.length > 1 && (
        <div className="card row between">
          <span className="small">
            {proposed.length} old invitations to withdraw. The robot withdraws at most 12 a day.
          </span>
          <button
            className="btn primary"
            onClick={async () => {
              if (
                !confirm(`Approve all ${proposed.length} withdrawals? At most 12 are done per day.`)
              )
                return;
              for (const r of proposed)
                await panelPost(`/panel/queue/${r.id}`, { decision: 'approve', text: null });
              toast(`${proposed.length} withdrawals approved.`);
              reload();
            }}
          >
            Approve all {proposed.length}
          </button>
        </div>
      )}
      {proposed.length === 0 && (
        <Empty>No {active.label.toLowerCase()} waiting for approval.</Empty>
      )}
      {proposed.map((r) => (
        <QueueCard key={r.id} row={r} onDone={(m) => (toast(m), reload())} />
      ))}

      {approved.length > 0 && (
        <div className="card stack">
          <div className="row between">
            <h2 style={{ margin: 0 }}>
              {approved.length} {active.label.toLowerCase()} approved
            </h2>
            <button className="btn" onClick={() => setShowApproved((v) => !v)}>
              {showApproved ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Approved items wait for send mode, which is not switched on yet. Each one is checked
            again right before sending (limits, schedule, and for messages whether the person wrote
            back).
          </p>
        </div>
      )}
      {showApproved &&
        approved.map((r) => <QueueCard key={r.id} row={r} onDone={(m) => (toast(m), reload())} />)}
    </>
  );
}

// ---------- Leads ----------

interface Lead {
  id: number;
  found_at: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  linkedin_url: string | null;
  keyword: string | null;
  score: number | null;
  verdict: 'staged' | 'approved';
  campaign_id: string | null;
  reason: string | null;
  company_domain?: string | null;
  signals?: Signal[];
}

function FindProspects({ onDone }: { onDone: (m: string) => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const run = async () => {
    try {
      const id = await startJob('prospect_round');
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus, 60 * 60_000);
      setStatus(null);
      onDone(r.message || r.status);
    } catch (e) {
      setStatus(null);
      onDone(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Find prospects</h2>
        <button className="btn primary" disabled={!!status} onClick={() => void run()}>
          Find prospects
        </button>
      </div>
      <div className="muted small">
        Searches LinkedIn with up to 4 of your keyword sets (one per campaign first, 2 to 4 pages
        each), filters out known people, pool and insurer staff and wrong titles, opens at most 12
        promising profiles, checks the fit against the campaign and adds the good ones: queued for
        an invite when the queue has room, otherwise listed here for you. About 20–30 minutes.
        Nothing is sent. Keywords: Settings → Prompts &amp; rules.
      </div>
      {status && <div className="small">{status}</div>}
    </div>
  );
}

// Add people by link (Jibran, 13.11.2026): profile links he found himself. The robot reads each profile,
// the server checks the fit for the chosen campaign, and the person appears below for his approval.
function AddByLink({ onDone }: { onDone: (m: string) => void }) {
  const { data: campaigns } = useData<Campaign[]>('/panel/campaigns', 0);
  const [text, setText] = useState('');
  const [campaign, setCampaign] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const links = text.match(/https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+/gi) ?? [];
  const run = async () => {
    try {
      const id = await startJob('import_leads', {
        urls: links.slice(0, 10),
        campaign: campaign || null,
      });
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus, 60 * 60_000);
      setStatus(null);
      setText('');
      onDone(r.message || r.status);
    } catch (e) {
      setStatus(null);
      onDone(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Add people by link</h2>
      <div className="muted small">
        Paste LinkedIn profile links you found yourself (one per line, up to 10). The robot reads
        each profile, checks the fit for the campaign and lists the person below for your approval.
        Nothing is sent.
      </div>
      <textarea
        rows={3}
        placeholder="https://www.linkedin.com/in/…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">Campaign: choose later</option>
          {(campaigns ?? [])
            .filter((c) => c.status === 'on')
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <button
          className="btn primary"
          disabled={!links.length || !!status}
          onClick={() => void run()}
        >
          Add {links.length ? Math.min(links.length, 10) : ''} to Leads
        </button>
      </div>
      {status && <div className="small">{status}</div>}
    </div>
  );
}

export function Leads({ refreshKey, toast }: { refreshKey: number; toast: (m: string) => void }) {
  const { data, error, reload } = useData<Lead[]>('/panel/leads', refreshKey);
  const { data: campaigns } = useData<Campaign[]>('/panel/campaigns', refreshKey);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [cohort, setCohort] = useState<string[]>([]);
  if (!data) return <Loading error={error} />;
  if (!data.length)
    return (
      <>
        {embedded && <FindProspects onDone={(m) => (toast(m), reload())} />}
        <AddByLink onDone={(m) => (toast(m), reload())} />
        <Companies refreshKey={refreshKey} toast={toast} onLeads={reload} />
        <Empty>No leads waiting. Prospect rounds stage new leads here.</Empty>
      </>
    );

  const decide = async (lead: Lead, decision: 'approve' | 'reject') => {
    setBusy(lead.id);
    setErr((x) => ({ ...x, [lead.id]: '' }));
    try {
      const r = await panelPost<{ verdict: string }>(`/panel/leads/${lead.id}`, {
        decision,
        campaignId: picked[lead.id] ?? lead.campaign_id,
      });
      toast(
        r.verdict === 'duplicate'
          ? 'Already a prospect.'
          : decision === 'approve'
            ? 'Added to the campaign. The invite waits for your approval.'
            : 'Rejected.',
      );
      reload();
    } catch (e) {
      setErr((x) => ({ ...x, [lead.id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {embedded && <FindProspects onDone={(m) => (toast(m), reload())} />}
      <AddByLink onDone={(m) => (toast(m), reload())} />
      <Companies refreshKey={refreshKey} toast={toast} onLeads={reload} />
      <SignalFilter leads={data} value={cohort} onChange={setCohort} />
      {data
        .filter((l) => hasSignals(l, cohort))
        .map((lead) => {
          const chosen = picked[lead.id] ?? lead.campaign_id ?? '';
          const chosenCampaign = campaigns?.find((c) => c.id === chosen);
          return (
            <div key={lead.id} className="card stack">
              <div className="row between">
                <span className="name">
                  <a
                    href={lead.linkedin_url ?? '#'}
                    onClick={(e) => (e.preventDefault(), openTab(lead.linkedin_url))}
                  >
                    {lead.full_name ?? 'Unknown'}
                  </a>
                </span>
                {lead.verdict === 'approved' ? (
                  <span className="badge ok">auto-added</span>
                ) : (
                  <span className="badge warn">staged</span>
                )}
              </div>
              <div className="muted small clip">
                {[lead.headline, lead.company].filter(Boolean).join(' · ')}
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {lead.keyword && (
                  <span className="badge">
                    {lead.keyword.startsWith('feed:') ? 'from a post' : `“${lead.keyword}”`}
                  </span>
                )}
                {lead.score !== null && <span className="badge">score {lead.score}</span>}
                <span className="muted small">{ago(lead.found_at)} ago</span>
              </div>
              <SignalChips signals={lead.signals} />
              {lead.reason && <div className="quote">{lead.reason}</div>}
              {lead.verdict === 'staged' && (
                <>
                  <label className="row small" style={{ gap: 6 }}>
                    <span className="muted">Campaign</span>
                    <select
                      value={chosen}
                      onChange={(e) => setPicked((x) => ({ ...x, [lead.id]: e.target.value }))}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <option value="">Choose…</option>
                      {campaigns?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} {c.status === 'on' ? '' : '(off)'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {chosenCampaign && chosenCampaign.status !== 'on' && (
                    <div className="muted small">
                      This campaign is off: the person is enrolled, but no invite is scheduled until
                      you switch it on (Today → Campaigns).
                    </div>
                  )}
                </>
              )}
              {err[lead.id] && <div className="error">{err[lead.id]}</div>}
              {lead.verdict === 'staged' && (
                <div className="actions">
                  <button
                    className="btn primary"
                    disabled={busy === lead.id || !chosen}
                    onClick={() => void decide(lead, 'approve')}
                  >
                    Add to campaign
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy === lead.id}
                    onClick={() => void decide(lead, 'reject')}
                  >
                    Not a fit
                  </button>
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

// ---------- Campaigns ----------

export interface Campaign {
  id: string;
  name: string;
  status: 'on' | 'off';
  description: string | null;
  steps: number;
  invited: number;
  accept_rate_pct: number | null;
  replied: number;
  reply_rate_pct: number | null;
  pending: number;
  in_sequence: number;
  waiting: number;
}

export function Campaigns({
  refreshKey,
  toast,
  onOpen,
}: {
  refreshKey: number;
  toast: (m: string) => void;
  onOpen?: (id: string) => void;
}) {
  const { data, error, reload } = useData<Campaign[]>('/panel/campaigns', refreshKey);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const toggle = async (c: Campaign) => {
    const next = c.status === 'on' ? 'off' : 'on';
    if (
      next === 'on' &&
      !confirm(
        `Switch "${c.name}" on? Its next steps get scheduled for the ${c.waiting} enrolled people. Nothing is sent without your approval.`,
      )
    )
      return;
    setBusy(c.id);
    try {
      await panelPost(`/panel/campaigns/${c.id}`, { status: next });
      toast(`${c.name} is ${next}.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card">
      <h2>Campaigns</h2>
      <div className="stack">
        {data.map((c) => (
          <div key={c.id} className="row between" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div className="name clip">
                {onOpen ? (
                  <a href="#" onClick={(e) => (e.preventDefault(), onOpen(c.id))}>
                    {c.name} ›
                  </a>
                ) : (
                  c.name
                )}
              </div>
              <div className="muted small">
                {c.invited} invited · {c.accept_rate_pct ?? 0}% accepted · {c.replied} replied
                {c.waiting ? ` · ${c.waiting} waiting` : ''}
              </div>
            </div>
            <button
              className={`btn ${c.status === 'on' ? 'primary' : ''}`}
              disabled={busy === c.id}
              onClick={() => void toggle(c)}
              title={c.status === 'on' ? 'Switch off' : 'Switch on'}
            >
              {c.status === 'on' ? 'On' : 'Off'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Comments ----------

interface CommentDraft {
  id: number;
  created_at: string;
  post_url: string | null;
  post_excerpt: string | null;
  post_age: string | null;
  author_name: string | null;
  author_headline: string | null;
  author_profile: string | null;
  comment_draft: string | null;
  reason: string | null;
  status: 'drafted' | 'approved' | 'check' | 'blocked' | 'posted' | 'rejected';
  block_reason?: string | null;
  verified?: boolean;
  posted_url?: string | null;
  last_attempt?: { note?: string; dryRun?: boolean; at?: string } | null;
}

const COMMENT_STATUS: Record<string, { label: string; cls: string }> = {
  drafted: { label: 'draft', cls: 'warn' },
  approved: { label: 'approved · post it yourself', cls: 'ok' },
  check: { label: 'Post pressed · please check on LinkedIn', cls: 'warn' },
  blocked: { label: 'blocked by the check', cls: 'bad' },
  posted: { label: 'marked posted by you', cls: '' },
  verified: { label: 'posted ✓ verified', cls: 'ok' },
};

function CommentCard({
  c,
  onDone,
  live,
}: {
  c: CommentDraft;
  onDone: (m: string) => void;
  live: boolean;
}) {
  const [posting, setPosting] = useState<string | null>(null);
  const [text, setText] = useState(c.comment_draft ?? '');
  const post = async () => {
    if (
      live &&
      !confirm(
        'Post this comment on LinkedIn now? It is fact-checked first, then typed and posted.',
      )
    )
      return;
    setPosting('Queued…');
    try {
      // Post what is in the box: an edited text is saved first (it is fact-checked again on the server).
      if (text.trim() !== (c.comment_draft ?? '').trim()) {
        await panelPost(`/panel/comments/${c.id}`, { decision: 'approve', text });
      }
      const id = await startJob('post_comment', { id: c.id });
      const r = await waitForJob(id, setPosting);
      setPosting(null);
      onDone(r.message || r.status);
    } catch (e) {
      setPosting(null);
      onDone(e instanceof Error ? e.message : String(e));
    }
  };
  const [error, setError] = useState<string | null>(null);
  const hasLink = !!c.post_url;
  const decide = async (decision: 'approve' | 'reject' | 'posted' | 'unpost' | 'copy') => {
    if (decision === 'copy') {
      await navigator.clipboard.writeText(text).catch(() => undefined);
      if (hasLink) openTab(c.post_url);
      onDone(hasLink ? 'Copied and opened the post.' : 'Copied.');
      return;
    }
    setError(null);
    if (
      decision === 'posted' &&
      !confirm(
        'Did you post this comment on LinkedIn yourself? The app does not post and cannot check it.',
      )
    )
      return;
    try {
      await panelPost(`/panel/comments/${c.id}`, {
        decision: decision === 'unpost' ? 'approve' : decision,
        text,
      });
      if (decision === 'approve') {
        onDone('Approved. Use “Post” (or copy it and post it yourself).');
      } else
        onDone(
          decision === 'posted'
            ? 'Marked as posted by you.'
            : decision === 'unpost'
              ? 'Back to approved.'
              : 'Rejected.',
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const status = (c.verified ? COMMENT_STATUS.verified : COMMENT_STATUS[c.status]) ?? {
    label: c.status,
    cls: '',
  };
  return (
    <div className="card stack">
      <div className="row between">
        <span className="name">
          <a
            href={c.author_profile ?? '#'}
            onClick={(e) => (e.preventDefault(), openTab(c.author_profile))}
          >
            {c.author_name ?? 'Post'}
          </a>
        </span>
        <span className={`badge ${status.cls}`}>{status.label}</span>
      </div>
      {c.author_headline && <div className="muted small clip">{c.author_headline}</div>}
      {c.post_excerpt && <div className="quote clip">{c.post_excerpt}</div>}
      {c.reason && <div className="muted small">Why: {c.reason}</div>}
      {c.status === 'blocked' && c.block_reason && (
        <div className="error small">
          Blocked before posting: {c.block_reason}
          <div className="muted">
            Edit the text below, then “Approve edited text”. It is checked again before posting.
          </div>
        </div>
      )}
      {!hasLink && c.status !== 'posted' && (
        <div className="muted small">
          No link to this post was found
          {c.author_profile ? ' (the author’s profile is linked above)' : ''}.
        </div>
      )}
      {c.last_attempt?.note && (
        <div className="muted small">
          Last {c.last_attempt.dryRun ? 'practice run' : 'attempt'}: {c.last_attempt.note}
        </div>
      )}
      {posting && <div className="small">{posting}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <div className="count">{[...text].length} characters</div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        {(c.status === 'drafted' || c.status === 'blocked') && (
          <button className="btn primary" onClick={() => void decide('approve')}>
            {c.status === 'blocked' ? 'Approve edited text' : 'Approve'}
          </button>
        )}
        {c.status !== 'posted' && (
          <button className="btn" onClick={() => void decide('copy')}>
            {hasLink ? 'Copy & open post' : 'Copy text'}
          </button>
        )}
        {c.status === 'approved' && embedded && (
          <button className="btn primary" disabled={!!posting} onClick={() => void post()}>
            {live ? 'Post' : 'Practice post'}
          </button>
        )}
        {(c.status === 'approved' || c.status === 'check') && (
          <button className="btn" onClick={() => void decide('posted')}>
            Mark as posted
          </button>
        )}
        {c.status === 'check' && (
          <button className="btn" onClick={() => void decide('unpost')}>
            Not posted · back to approved
          </button>
        )}
        {c.status === 'posted' && (c.posted_url || c.post_url) && (
          <button className="btn" onClick={() => openTab(c.posted_url ?? c.post_url)}>
            Open post
          </button>
        )}
        {c.status === 'posted' && (
          <button className="btn" onClick={() => void decide('unpost')}>
            Not posted after all
          </button>
        )}
        {c.status !== 'posted' && (
          <button className="btn danger" onClick={() => void decide('reject')}>
            Reject
          </button>
        )}
      </div>
    </div>
  );
}

interface RoundState {
  state: 'idle' | 'running' | 'done' | 'error' | 'stopped';
  startedAt?: string;
  finishedAt?: string;
  posts?: number;
  steps?: number;
  drafted?: number;
  message?: string;
  schedule?: boolean;
  times?: string[];
}

// The comment round: the extension opens its own LinkedIn window in the background, scrolls the feed
// at the conduct pace, drafts ideas, closes the window. Nothing is liked, commented or posted.
function CommentRound({ onDone }: { onDone: (m: string) => void }) {
  const [st, setSt] = useState<RoundState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    askExtension<RoundState>('commentRoundStatus').then(setSt, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(load, [load]);
  const [progress, setProgress] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    try {
      const id = await startJob('comment_round');
      setProgress('Queued…');
      const r = await waitForJob(id, setProgress);
      setProgress(null);
      load();
      onDone(r.message || 'Comment round finished.');
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const toggleSchedule = async () => {
    const on = !st?.schedule;
    await askExtension('setRoundSchedule', { on });
    setSt((s) => ({ ...(s ?? { state: 'idle' }), schedule: on }));
    onDone(
      on ? `Automatic rounds on: ${(st?.times ?? []).join(' and ')}.` : 'Automatic rounds off.',
    );
  };

  if (!st) return error ? <div className="card error">{error}</div> : null;
  const running = !!progress;
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Comment round</h2>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!st.schedule} onChange={() => void toggleSchedule()} />
          Automatic {st.times?.join(' & ')}
        </label>
      </div>
      <div className="muted small">
        Opens the robot tab, scrolls your feed like a reader (20-30 posts, up to 8 minutes), drafts
        comment ideas and closes the tab. Nothing is liked or posted. Only 07:00–21:00. Follow it in
        the robot bar at the top.
      </div>
      {running ? (
        <div className="row between">
          <span className="small">{progress}</span>
        </div>
      ) : (
        <div className="actions">
          <button className="btn primary" onClick={() => void start()}>
            Run comment round
          </button>
        </div>
      )}
      {!running && st.message && (
        <div className={`small ${st.state === 'error' ? 'error' : 'muted'}`}>
          Last round{st.finishedAt ? ` (${ago(st.finishedAt)} ago)` : ''}: {st.message}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function Comments({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const [filter, setFilter] = useState<
    'review' | 'approved' | 'blocked' | 'posted' | 'rejected' | 'library'
  >('review');
  const list = useData<{ counts: Record<string, number>; items: CommentDraft[] }>(
    `/panel/comments/list?filter=${filter === 'library' ? 'review' : filter}`,
    refreshKey,
  );
  const data = list.data?.items ?? null;
  const error = list.error;
  const reload = list.reload;
  const { data: mode, reload: reloadMode } = useData<{ live: boolean }>(
    '/panel/comment-mode',
    refreshKey,
  );
  const live = mode?.live === true;
  const { data: auto, reload: reloadAuto } = useData<{
    on: boolean;
    next: string | null;
    daily_max: number;
    posted_today: number;
  }>('/panel/autopost', refreshKey);
  const toggleAuto = async () => {
    const on = !auto?.on;
    if (
      on &&
      !confirm(
        `Post approved comments automatically, spread over the day (max ${auto?.daily_max ?? 5} per day, 07–21)? Each one is fact-checked first.`,
      )
    )
      return;
    await panelPost('/panel/autopost', { on });
    reloadAuto();
    toast(on ? 'Auto-post is on.' : 'Auto-post is off.');
  };
  const switchMode = async () => {
    if (
      !live &&
      !confirm(
        'Switch to LIVE posting? “Post” will then really publish the comment on LinkedIn (after the fact check).',
      )
    )
      return;
    await panelPost('/panel/comment-mode', { live: !live });
    reloadMode();
    toast(!live ? 'Live posting is on.' : 'Back to practice mode.');
  };
  return (
    <>
      {embedded && mode && (
        <div className="card stack">
          <div className="row between">
            <span className="small">
              Posting mode: <b>{live ? 'Live' : 'Practice'}</b>
              <span className="muted">
                {' '}
                · {live ? 'Post publishes after the fact check' : 'types it, does not press Post'}
              </span>
            </span>
            <button className={`btn ${live ? 'danger' : ''}`} onClick={() => void switchMode()}>
              {live ? 'Back to practice' : 'Go live'}
            </button>
          </div>
          {auto && (
            <div className="row between">
              <label className="row small" style={{ gap: 6, cursor: live ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={auto.on}
                  disabled={!live}
                  onChange={() => void toggleAuto()}
                />
                Auto-post approved comments
              </label>
              <span className="muted small">
                {!live
                  ? 'needs Live mode'
                  : auto.on
                    ? `${auto.posted_today}/${auto.daily_max} today${auto.next && Date.parse(auto.next) > Date.now() ? ` · next after ${new Date(auto.next).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}`
                    : 'off'}
              </span>
            </div>
          )}
        </div>
      )}
      {embedded && <CommentRound onDone={(m) => (toast(m), reload())} />}
      <div className="tabs" role="tablist" style={{ marginTop: 4 }}>
        {(
          [
            ['review', 'To review'],
            ['approved', 'Approved'],
            ['blocked', 'Blocked'],
            ['posted', 'Posted'],
            ['rejected', 'Rejected'],
            ['library', 'Library'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            className="tab"
            aria-selected={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
            {id !== 'library' && !!list.data?.counts[id] && (
              <span className="n">{list.data.counts[id]}</span>
            )}
          </button>
        ))}
      </div>
      {filter === 'library' ? (
        <CommentLibrary refreshKey={refreshKey} toast={toast} />
      ) : !data ? (
        <Loading error={error} />
      ) : !data.length ? (
        <Empty>
          {filter === 'review'
            ? 'No new comment ideas. Run a comment round to find some.'
            : filter === 'approved'
              ? 'Nothing approved waiting to be posted.'
              : filter === 'blocked'
                ? 'Nothing blocked. Comments the fact check refuses land here, with the reason.'
                : filter === 'posted'
                  ? 'No posted comments yet.'
                  : 'No rejected comments.'}
        </Empty>
      ) : (
        data.map((c) => (
          <CommentCard key={c.id} c={c} live={live} onDone={(m) => (toast(m), reload())} />
        ))
      )}
    </>
  );
}

// ---------- Campaign detail ----------

interface CampaignDetail {
  id: string;
  name: string;
  status: 'on' | 'off';
  description: string | null;
  target_group: string | null;
  steps: { step: number; action: string; text: string | null; delay_hours: number }[];
  stages: Record<string, number>;
  queue: Record<string, number>;
}

const STEP_LABEL: Record<string, string> = {
  connect: 'Invite',
  message: 'Message',
  inmail: 'InMail',
  visit: 'Profile visit',
  follow: 'Follow',
  endorse: 'Endorse',
  likepost: 'Like a post',
  disconnect: 'Disconnect',
};
const STAGE_ORDER = [
  'approved',
  'visited',
  'invited',
  'accepted',
  'msg1_sent',
  'msg2_sent',
  'msg3_sent',
  'replied',
  'completed',
  'withdrawn',
  'skipped',
  'blacklisted',
  'already_connected',
  'found',
];

function delayText(hours: number, step: number, prevAction: string | undefined): string {
  const after =
    step === 1
      ? 'after enrolment'
      : prevAction === 'connect'
        ? 'after they accept'
        : 'after the previous step';
  if (hours === 0) return `right ${after}`;
  return hours % 24 === 0
    ? `${hours / 24} day${hours === 24 ? '' : 's'} ${after}`
    : `${hours} h ${after}`;
}

interface Kw {
  keyword: string;
  segment: string;
  campaign: string | null;
  stage_only?: boolean;
  enabled?: boolean;
}

function KeywordEditor({ campaign }: { campaign: string }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useData<{
    keywords: Kw[];
    stats: Record<
      string,
      { looked_at: number; approved: number; staged: number; last_used: string | null }
    >;
  }>('/panel/keywords', tick);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return error ? <div className="error small">{error}</div> : null;
  const mine = data.keywords.filter((k) => k.campaign === campaign);
  const segment = mine[0]?.segment ?? campaign.split('-')[0] ?? 'other';
  const save = async (keywords: Kw[], done: string) => {
    try {
      await panelPost('/panel/keywords', { keywords });
      setMsg(done);
      setTick((t) => t + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const add = () => {
    const words = text
      .split(/[,\n]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (!words.length) return;
    const existing = new Set(data.keywords.map((k) => k.keyword.toLowerCase()));
    const fresh = words
      .filter((w) => !existing.has(w.toLowerCase()))
      .map((w) => ({ keyword: w, segment, campaign }));
    setText('');
    void save(
      [...data.keywords, ...fresh],
      `${fresh.length} keyword${fresh.length === 1 ? '' : 's'} added.`,
    );
  };
  const update = (kw: string, change: Partial<Kw> | null) =>
    save(
      change === null
        ? data.keywords.filter((k) => k.keyword !== kw)
        : data.keywords.map((k) => (k.keyword === kw ? { ...k, ...change } : k)),
      change === null ? `"${kw}" removed.` : 'Saved.',
    );
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Prospecting keywords</h2>
      <div className="muted small">
        “Find prospects” searches LinkedIn with these (3 per round, the least recently used first).
        Tip from your tests: one distinctive noun (Versicherungsmakler, Maklerbüro) works; a generic
        role word next to it (Geschäftsführer, Inhaber) dilutes the results.
      </div>
      {mine.length === 0 && <div className="muted small">No keywords for this campaign yet.</div>}
      {mine.map((k) => {
        const st = data.stats[k.keyword];
        const on = k.enabled !== false;
        return (
          <div key={k.keyword} className="row between small" style={{ gap: 8 }}>
            <span style={{ opacity: on ? 1 : 0.5 }}>
              <strong>{k.keyword}</strong>
              {k.stage_only && <span className="muted"> · review only</span>}
              <span className="muted">
                {st
                  ? ` · ${st.looked_at} looked at, ${st.approved} approved, ${st.staged} for review · last ${ago(st.last_used)} ago`
                  : ' · not used yet'}
              </span>
            </span>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn" onClick={() => void update(k.keyword, { enabled: !on })}>
                {on ? 'Pause' : 'Use'}
              </button>
              <button className="btn danger" onClick={() => void update(k.keyword, null)}>
                Remove
              </button>
            </span>
          </div>
        );
      })}
      <div className="row" style={{ gap: 6 }}>
        <input
          value={text}
          placeholder="e.g. Versicherungsmaklerin, Mehrfachagent"
          style={{ flex: 1 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn primary" disabled={!text.trim()} onClick={add}>
          Add
        </button>
      </div>
      {msg && <div className="small muted">{msg}</div>}
    </div>
  );
}

function CampaignView({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error } = useData<CampaignDetail>(`/panel/campaigns/${id}`, 0);
  if (!data) return <Loading error={error} />;
  const stages = STAGE_ORDER.filter((s) => data.stages[s]).map(
    (s) => [s, data.stages[s]!] as const,
  );
  return (
    <>
      <div className="card stack">
        <div className="row between">
          <button className="btn" onClick={onBack}>
            ← Campaigns
          </button>
          <span className={`badge ${data.status === 'on' ? 'ok' : ''}`}>{data.status}</span>
        </div>
        <h2 style={{ margin: 0 }}>{data.name}</h2>
        {data.target_group && (
          <>
            <div className="muted small">Who it is for (the fit check uses this)</div>
            <div className="quote clip">{data.target_group}</div>
          </>
        )}
      </div>
      <KeywordEditor campaign={data.id} />
      <OpeningStats campaign={data.id} />
      <div className="card stack">
        <h2>Sequence</h2>
        {data.steps.length === 0 && <div className="muted small">No steps.</div>}
        {data.steps.map((st, i) => (
          <div key={st.step} className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="badge">{st.step}</span>
              <span className="name">{STEP_LABEL[st.action] ?? st.action}</span>
              <span className="muted small">
                {delayText(st.delay_hours, st.step, data.steps[i - 1]?.action)}
              </span>
            </div>
            {st.action === 'connect' && (
              <div className="muted small">
                The note is written per person from a real trigger; this text is only the fallback.
              </div>
            )}
            {st.text && <div className="quote">{st.text}</div>}
          </div>
        ))}
        <div className="muted small">Any reply stops the sequence for that person.</div>
      </div>
      <div className="card">
        <h2>Where the people are</h2>
        {stages.length === 0 && <div className="muted small">Nobody enrolled yet.</div>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {stages.map(([k, n]) => (
            <span key={k} className="badge">
              {k.replace('_', ' ')} {n}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

export function CampaignsTab({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <CampaignView id={open} onBack={() => setOpen(null)} />;
  return <Campaigns refreshKey={refreshKey} toast={toast} onOpen={setOpen} />;
}

// ---------- Activity ----------

interface ActivityItem {
  kind: 'event' | 'run';
  at: string;
  type: string;
  ok: boolean;
  campaign_id: string | null;
  full_name: string | null;
  linkedin_url: string | null;
  note: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  found: 'New prospect',
  visit: 'Profile checked',
  invite_sent: 'Invite sent',
  invite_withdrawn: 'Invite withdrawn',
  accepted: 'Accepted',
  message_sent: 'Message sent',
  reply_detected: 'Replied',
  skipped: 'Skipped',
  error: 'Error',
  stage_change: 'Stage changed',
  limit_warning: 'LinkedIn warning',
};

export function Activity({ refreshKey }: { refreshKey: number }) {
  const { data, error } = useData<ActivityItem[]>('/panel/activity', refreshKey);
  if (!data) return <Loading error={error} />;
  if (!data.length) return <Empty>No activity yet.</Empty>;
  return (
    <div className="card timeline">
      {data.map((a, i) => (
        <div key={i} className="tl">
          <span className="t">{ago(a.at)}</span>
          <div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span
                className={`badge ${!a.ok ? 'bad' : a.type === 'reply_detected' || a.type === 'accepted' ? 'ok' : ''}`}
              >
                {a.kind === 'run' ? `run · ${a.type}` : (EVENT_LABEL[a.type] ?? a.type)}
              </span>
              {a.full_name && (
                <a
                  className="name"
                  href={a.linkedin_url ?? '#'}
                  onClick={(e) => (e.preventDefault(), openTab(a.linkedin_url))}
                >
                  {a.full_name}
                </a>
              )}
            </div>
            {a.note && <div className="muted small clip">{a.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
