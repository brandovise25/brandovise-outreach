import { useEffect, useState } from 'react';
import { ago, openTab, panelPost } from './api.ts';
import { useData } from './views.tsx';

// Replies inbox (Jibran, 13.11.2026): everyone who wrote back, how the reply was sorted, and where the
// conversation stands. Drafted answers wait under "Replies" in the list below; nothing is sent without
// an approval. A clear "do not write again" has already blocked the person.

interface ReplyItem {
  id: number;
  full_name: string;
  company: string | null;
  campaign_id: string | null;
  linkedin_url: string;
  replied_at: string | null;
  stage: string;
  snippet: string | null;
  outcome: string | null;
  priority: number | null;
  reason: string | null;
  answered_at: string | null;
  deal_stage: string | null;
  deal_note: string | null;
  draft_status: string | null;
}
interface Inbox {
  counts: { unclassified: number; open: number; needs_jibran: number; deals: number; won: number };
  items: ReplyItem[];
}
const OUTCOME: Record<string, string> = {
  interested: 'interested',
  question: 'question',
  objection: 'objection',
  not_now: 'later',
  not_interested: 'no',
  wrong_target: 'wrong person',
  out_of_office: 'out of office',
  opt_out: 'do not contact',
  needs_jibran: 'needs you',
  other: 'other',
};
const DEAL = ['engaged', 'qualifying', 'meeting', 'won', 'lost'];

function ReplyCard({ r, onDone }: { r: ReplyItem; onDone: (m: string) => void }) {
  const [text, setText] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    try {
      await panelPost(path, body);
      onDone(done);
    } catch (e) {
      onDone(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const urgent = r.outcome === 'needs_jibran' || r.priority === 1;
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row between small">
        <a href={r.linkedin_url} onClick={(e) => (e.preventDefault(), openTab(r.linkedin_url))}>
          <b>{r.full_name}</b>
          {r.company ? ` · ${r.company}` : ''}
        </a>
        <span className="muted">{ago(r.replied_at)}</span>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <span className={`badge ${urgent ? 'warn' : ''}`}>
          {r.outcome ? (OUTCOME[r.outcome] ?? r.outcome) : 'not sorted yet'}
        </span>
        {r.draft_status === 'proposed' && <span className="badge">draft waits below</span>}
        {r.draft_status === 'approved' && <span className="badge ok">answer approved</span>}
        {r.draft_status === 'done' && <span className="badge ok">answered</span>}
        {r.answered_at && <span className="badge ok">answered by you</span>}
        {r.campaign_id && <span className="badge">{r.campaign_id}</span>}
      </div>
      {r.snippet && <div className="quote">They wrote: {r.snippet}</div>}
      {r.reason && <div className="muted small">{r.reason}</div>}
      {writing && (
        <textarea
          rows={4}
          placeholder="Your answer. It is saved as a draft under Replies below, where you approve it."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {!r.draft_status && !writing && (
          <button className="btn" onClick={() => setWriting(true)}>
            Write an answer
          </button>
        )}
        {writing && (
          <button
            className="btn primary"
            disabled={busy || !text.trim()}
            onClick={() =>
              void act(
                `/panel/replies/${r.id}`,
                { action: 'save', text },
                'Draft saved under Replies.',
              )
            }
          >
            Save draft
          </button>
        )}
        <button
          className="btn"
          disabled={busy}
          title="You answered this on LinkedIn yourself"
          onClick={() =>
            void act(`/panel/replies/${r.id}`, { action: 'answered' }, 'Marked as answered.')
          }
        >
          Answered myself
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(`/panel/replies/${r.id}`, { action: 'dismiss' }, 'No answer needed.')
          }
        >
          No answer needed
        </button>
        <select
          value={r.deal_stage ?? ''}
          disabled={busy}
          title="Where this conversation stands"
          onChange={(e) =>
            void act(
              `/panel/deals/${r.id}`,
              { stage: e.target.value || null, note: r.deal_note },
              'Deal stage saved.',
            )
          }
        >
          <option value="">Deal: none</option>
          {DEAL.map((d) => (
            <option key={d} value={d}>
              Deal: {d}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function RepliesInbox({
  refreshKey,
  toast,
  onChanged,
}: {
  refreshKey: number;
  toast: (m: string) => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<'open' | 'deals' | 'all'>('open');
  const [open, setOpen] = useState(false);
  const [sorting, setSorting] = useState(false);
  const { data, reload } = useData<Inbox>(`/panel/replies?filter=${filter}`, refreshKey);
  const sort = async (quiet: boolean) => {
    setSorting(true);
    try {
      const r = await panelPost<{
        seen: number;
        drafted: number;
        blocked: number;
        for_jibran: number;
        deferred: number;
      }>('/panel/replies/process', { max: 10 });
      if (r.seen) {
        reload();
        onChanged();
      }
      if (!quiet)
        toast(
          r.seen
            ? `${r.seen} replies looked at: ${r.drafted} answers drafted, ${r.for_jibran} need you, ${r.blocked} blocked${r.deferred ? `, ${r.deferred} left for later` : ''}.`
            : 'No new replies.',
        );
    } catch (e) {
      if (!quiet) toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSorting(false);
    }
  };
  // New replies are sorted when the tab opens (ten at a time).
  useEffect(() => {
    void sort(true);
  }, [refreshKey]);
  if (!data) return null;
  const c = data.counts;
  if (!c.open && !c.unclassified && !c.deals && !c.won && !data.items.length) return null;
  const done = (m: string) => (toast(m), reload(), onChanged());
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Replies</h2>
        <button className="btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="small">
        {c.open} to answer{c.needs_jibran ? ` · ${c.needs_jibran} need you (legal wording)` : ''}
        {c.unclassified ? ` · ${c.unclassified} not sorted yet` : ''} · {c.deals} open deals ·{' '}
        {c.won} won
      </div>
      {c.unclassified > 0 && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn" disabled={sorting} onClick={() => void sort(false)}>
            {sorting ? 'Sorting…' : `Sort the next ${Math.min(10, c.unclassified)}`}
          </button>
        </div>
      )}
      {open && (
        <>
          <div className="row" style={{ gap: 4 }}>
            {(['open', 'deals', 'all'] as const).map((f) => (
              <button
                key={f}
                className={`btn ${filter === f ? 'primary' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'open' ? 'To answer' : f === 'deals' ? 'Deals' : 'All'}
              </button>
            ))}
          </div>
          {data.items.map((r) => (
            <ReplyCard key={r.id} r={r} onDone={done} />
          ))}
          {!data.items.length && <div className="small muted">Nothing here.</div>}
        </>
      )}
    </div>
  );
}

// ---------- Leads -> Replied (18.11.2026) ----------
// Everyone who wrote back, in sections. The AI reads the date out of "later" replies and drafts a
// follow-up for hot ones and for "later" ones whose date has come; each draft waits here (and in
// Approve) for an edit and an approval. Nothing is sent without that click.

interface BoardItem {
  id: number;
  full_name: string;
  headline: string | null;
  company: string | null;
  campaign_id: string | null;
  linkedin_url: string;
  replied_at: string | null;
  snippet: string | null;
  outcome: string | null;
  reason: string | null;
  follow_up_on: string | null;
  deal_stage: string | null;
  deal_note: string | null;
  draft_status: string | null;
  draft: string | null;
  draft_stale: boolean | null;
  section: 'hot' | 'due' | 'later' | 'answered' | 'closed';
  last_sent: string | null;
}
const SECTIONS: { id: BoardItem['section']; title: string; explain: string }[] = [
  {
    id: 'hot',
    title: 'Hot',
    explain: 'Interested, asked something or objected, and not answered yet.',
  },
  { id: 'due', title: 'Due now', explain: 'Said "later", and the date they named has come.' },
  { id: 'later', title: 'Later', explain: 'Said "later"; the follow-up date is still ahead.' },
  { id: 'answered', title: 'Answered', explain: 'Answered by the robot or by you.' },
  { id: 'closed', title: 'Closed', explain: 'No, wrong person, do not contact, out of office.' },
];
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('de-DE') : '');

function BoardCard({ r, onDone }: { r: BoardItem; onDone: (m: string) => void }) {
  const usable = r.draft_status === 'proposed' || (r.draft_status === 'approved' && !r.draft_stale);
  const [text, setText] = useState(usable ? (r.draft ?? '') : '');
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    try {
      await panelPost(path, body);
      onDone(done);
    } catch (e) {
      onDone(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const canDraft = r.section === 'hot' || r.section === 'due';
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row between small">
        <a href={r.linkedin_url} onClick={(e) => (e.preventDefault(), openTab(r.linkedin_url))}>
          <b>{r.full_name}</b>
          {r.company ? ` · ${r.company}` : ''}
        </a>
        <span className="muted">replied {fmtDate(r.replied_at)}</span>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <span className={`badge ${r.section === 'hot' || r.section === 'due' ? 'warn' : ''}`}>
          {r.outcome ? (OUTCOME[r.outcome] ?? r.outcome) : 'not sorted yet'}
        </span>
        {r.draft_status === 'approved' && !r.draft_stale && (
          <span className="badge ok">answer approved, goes out with the next send round</span>
        )}
        {r.draft_stale && <span className="badge warn">old approval, never sent</span>}
        {r.deal_stage && <span className="badge">deal: {r.deal_stage}</span>}
        {r.campaign_id && <span className="badge">{r.campaign_id}</span>}
      </div>
      {r.snippet && <div className="quote">They wrote: {r.snippet}</div>}
      {r.reason && <div className="muted small">{r.reason}</div>}
      {(r.section === 'later' || r.section === 'due') && (
        <label className="row small" style={{ gap: 6 }}>
          Follow up on
          <input
            type="date"
            value={r.follow_up_on ?? ''}
            disabled={busy}
            onChange={(e) =>
              void act(
                `/panel/replies/${r.id}/follow-up-on`,
                { on: e.target.value || null },
                'Follow-up date saved.',
              )
            }
          />
          {!r.follow_up_on && <span className="muted">(the AI reads it from their reply)</span>}
        </label>
      )}
      {(usable || text) && (
        <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {canDraft && !usable && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void act(
                '/panel/replies/follow-ups',
                { id: r.id },
                'Follow-up drafted. Check it and approve.',
              )
            }
          >
            {busy ? 'Writing…' : 'Draft follow-up with AI'}
          </button>
        )}
        {text.trim() && (
          <>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void act(
                  `/panel/replies/${r.id}`,
                  { action: 'approve', text },
                  'Approved: the robot sends it with the next send round.',
                )
              }
            >
              Approve and send
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(`/panel/replies/${r.id}`, { action: 'save', text }, 'Draft saved.')
              }
            >
              Save draft
            </button>
          </>
        )}
        <button
          className="btn"
          disabled={busy}
          title="You answered this on LinkedIn yourself"
          onClick={() =>
            void act(`/panel/replies/${r.id}`, { action: 'answered' }, 'Marked as answered.')
          }
        >
          Answered myself
        </button>
        {r.section !== 'closed' && r.section !== 'answered' && (
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(`/panel/replies/${r.id}`, { action: 'dismiss' }, 'No answer needed.')
            }
          >
            No answer needed
          </button>
        )}
      </div>
    </div>
  );
}

export function ReplyBoard({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const { data, reload } = useData<BoardItem[]>('/panel/replies/board', refreshKey);
  const [open, setOpen] = useState<Record<string, boolean>>({ hot: true, due: true });
  const [running, setRunning] = useState(false);
  if (!data) return null;
  const done = (m: string) => (toast(m), reload());
  const runAll = async () => {
    setRunning(true);
    try {
      const r = await panelPost<{ dated: number; drafted: number; failed: number }>(
        '/panel/replies/follow-ups',
        { max: 10 },
      );
      done(
        r.dated || r.drafted
          ? `${r.dated} follow-up dates read, ${r.drafted} follow-ups drafted${r.failed ? ` (${r.failed} need a closer look)` : ''}.`
          : 'Nothing new to draft.',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  const count = (s: string) => data.filter((r) => r.section === s).length;
  return (
    <>
      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Replied</h2>
          <button className="btn" disabled={running} onClick={() => void runAll()}>
            {running ? 'Drafting…' : 'Draft follow-ups now'}
          </button>
        </div>
        <div className="small muted">
          {count('hot')} hot · {count('due')} due now · {count('later')} later · {count('answered')}{' '}
          answered · {count('closed')} closed. Follow-ups are drafted by the AI every 15 minutes (a
          few at a time) and always wait for your approval.
        </div>
      </div>
      {SECTIONS.map((s) => {
        const items = data.filter((r) => r.section === s.id);
        if (!items.length) return null;
        return (
          <div key={s.id} className="card stack">
            <div className="row between">
              <b>
                {s.title} {items.length}
              </b>
              <button className="btn" onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                {open[s.id] ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className="small muted">{s.explain}</div>
            {open[s.id] && items.map((r) => <BoardCard key={r.id} r={r} onDone={done} />)}
          </div>
        );
      })}
    </>
  );
}
