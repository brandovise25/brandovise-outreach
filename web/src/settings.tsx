import { SecretField } from './companies.tsx';
import { useEffect, useState } from 'react';
import { panelPost } from './api.ts';
import { useData } from './views.tsx';

// Settings tab: when invites and messages may be sent, daily/weekly caps, robot hours and pauses,
// comment round times. Every change is checked on the server. Dry run and live posting have their own
// switches and are not changed here.

type Entry = { value: unknown; note: string | null; updated_at: string };
type Settings = Record<string, Entry | undefined>;
const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_KEY = ['1', '2', '3', '4', '5', '6', '0']; // robot_schedule uses 0 = Sunday

function useSave(toast: (m: string) => void, reload: () => void) {
  return async (key: string, value: unknown, label: string) => {
    try {
      await panelPost(`/panel/settings/${key}`, { value });
      toast(`${label} saved.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
}

const on = (e: Entry | undefined) => e?.value === true || e?.value === 'true';

// Live sending switch (Jibran, 17.10.2026). Going live asks for the word LIVE; the server checks it too.
function LiveCard({
  s,
  toast,
  reload,
}: {
  s: Settings;
  toast: (m: string) => void;
  reload: () => void;
}) {
  const live = s.ext_dry_run?.value === false || s.ext_dry_run?.value === 'false';
  async function setLive(next: boolean) {
    let confirm: string | undefined;
    if (next) {
      const typed = window.prompt(
        `Switch LIVE sending on? Approved invites and messages will really be sent on LinkedIn (max ${String(s.daily_invite_cap?.value ?? '?')} invites per day, ${String(s.weekly_invite_cap?.value ?? '?')} per 7 days). Type LIVE to confirm.`,
      );
      if (typed?.trim().toUpperCase() !== 'LIVE') return toast('Not switched: LIVE was not typed.');
      confirm = 'LIVE';
    }
    try {
      await panelPost('/panel/live', { live: next, confirm });
      toast(next ? 'Live sending is on.' : 'Back to dry run: nothing is sent.');
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="card stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Sending mode</h2>
        <button
          className={`btn ${live ? 'primary' : 'danger'}`}
          onClick={() => void setLive(!live)}
        >
          {live ? 'Back to dry run' : 'Go live'}
        </button>
      </div>
      <div className="muted small">
        {live
          ? 'LIVE: approved invites, messages and withdrawals are really sent.'
          : 'Dry run: “Send approved” only practises (opens, types, cancels). Nothing is sent.'}
      </div>
    </div>
  );
}

function NumberField({
  label,
  k,
  s,
  save,
  min,
  max,
  help,
}: {
  label: string;
  k: string;
  s: Settings;
  save: ReturnType<typeof useSave>;
  min: number;
  max: number;
  help?: string;
}) {
  const [v, setV] = useState(String(s[k]?.value ?? ''));
  useEffect(() => setV(String(s[k]?.value ?? '')), [s, k]);
  return (
    <label className="row between small" style={{ gap: 8 }}>
      <span>
        {label}
        {help && <span className="muted"> · {help}</span>}
      </span>
      <span className="row" style={{ gap: 6 }}>
        <input
          type="number"
          min={min}
          max={max}
          value={v}
          style={{ width: 80 }}
          onChange={(e) => setV(e.target.value)}
        />
        <button
          className="btn"
          disabled={v === String(s[k]?.value ?? '')}
          onClick={() => void save(k, Number(v), label)}
        >
          Save
        </button>
      </span>
    </label>
  );
}

function Schedule({ s, save }: { s: Settings; save: ReturnType<typeof useSave> }) {
  const current = (s.robot_schedule?.value ?? {}) as Record<string, [string, string][]>;
  const [rows, setRows] = useState<Record<string, { on: boolean; from: string; to: string }>>({});
  useEffect(() => {
    const r: Record<string, { on: boolean; from: string; to: string }> = {};
    for (const d of DAY_KEY) {
      const w = current[d]?.[0];
      r[d] = { on: !!w, from: w?.[0] ?? '08:00', to: w?.[1] ?? '18:00' };
    }
    setRows(r);
  }, [s]);
  const apply = () => {
    const out: Record<string, [string, string][]> = {};
    for (const d of DAY_KEY) out[d] = rows[d]?.on ? [[rows[d]!.from, rows[d]!.to]] : [];
    void save('robot_schedule', out, 'Send times');
  };
  if (!Object.keys(rows).length) return null;
  return (
    <div className="stack small">
      {DAY_KEY.map((d, i) => (
        <div key={d} className="row" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 6, width: 56, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={rows[d]!.on}
              onChange={(e) => setRows({ ...rows, [d]: { ...rows[d]!, on: e.target.checked } })}
            />
            {DAYS[i]}
          </label>
          <input
            type="time"
            value={rows[d]!.from}
            disabled={!rows[d]!.on}
            onChange={(e) => setRows({ ...rows, [d]: { ...rows[d]!, from: e.target.value } })}
          />
          –
          <input
            type="time"
            value={rows[d]!.to}
            disabled={!rows[d]!.on}
            onChange={(e) => setRows({ ...rows, [d]: { ...rows[d]!, to: e.target.value } })}
          />
        </div>
      ))}
      <div className="actions">
        <button className="btn primary" onClick={apply}>
          Save send times
        </button>
      </div>
    </div>
  );
}

export function SettingsTab({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const { data, error, reload } = useData<Settings>('/panel/settings', refreshKey);
  const save = useSave(toast, reload);
  const [roundTimes, setRoundTimes] = useState('');
  const [hours, setHours] = useState({ from: 7, to: 21 });
  const [gap, setGap] = useState({ min: 3, max: 10 });
  useEffect(() => {
    if (!data) return;
    setRoundTimes(((data.comment_round_times?.value as string[]) ?? []).join(', '));
    const h = data.job_hours?.value as { from: number; to: number } | undefined;
    if (h) setHours(h);
    const g = data.job_gap_seconds?.value as { min: number; max: number } | undefined;
    if (g) setGap({ min: Math.round(g.min / 60), max: Math.round(g.max / 60) });
  }, [data]);
  if (!data) return <div className="card empty">{error ?? 'Loading…'}</div>;
  const paused = data.paused?.value === true || data.paused?.value === 'true';
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Robot</h2>
          <button
            className={`btn ${paused ? 'primary' : 'danger'}`}
            onClick={() => void save('paused', !paused, paused ? 'Robot resumed' : 'Robot paused')}
          >
            {paused ? 'Resume robot' : 'Pause everything'}
          </button>
        </div>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={data.sync_auto?.value === true || data.sync_auto?.value === 'true'}
            onChange={(e) => void save('sync_auto', e.target.checked, 'Automatic sync')}
          />
          Sync LinkedIn automatically every 25–40 minutes (accepted invites, new replies, pending
          count)
        </label>
        <div className="muted small">
          {paused
            ? 'Paused: nothing runs on LinkedIn and nothing is sent.'
            : 'Running. “Pause everything” stops all LinkedIn work at once.'}
        </div>
      </div>

      <LiveCard s={data} toast={toast} reload={reload} />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Keys</h2>
        <SecretField
          name="serper_api_key"
          label="Web search key (Serper)"
          help="Optional. Lets the app search the web for companies (Leads → Companies). From serper.dev; stored encrypted and never shown again."
          toast={toast}
        />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Automatic</h2>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={on(data.prospect_auto)}
            onChange={(e) => void save('prospect_auto', e.target.checked, 'Automatic prospecting')}
          />
          Find prospects automatically: one round on weekday mornings (random time 08–10). New leads
          still wait in Approve for your click. Skipped while 40 or more leads are waiting.
        </label>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={on(data.send_auto)}
            onChange={(e) => void save('send_auto', e.target.checked, 'Automatic sending')}
          />
          Send approved invites, messages and withdrawals automatically: 4–6 at a time, 60–120
          minutes apart, only inside the send times and only when live.
        </label>
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={on(data.auto_approve)}
            onChange={(e) => {
              if (e.target.checked) {
                const typed = window.prompt(
                  'Approve invites and follow-up messages WITHOUT asking you? Each text is still checked in code first (length, banned phrases, Sie-form, a concrete fact about the person). Texts that fail a check wait in Approve. Replies are never approved automatically. Type AUTO to confirm.',
                );
                if (typed?.trim().toUpperCase() !== 'AUTO')
                  return toast('Not switched: AUTO was not typed.');
              }
              void save('auto_approve', e.target.checked, 'Automatic approval');
            }}
          />
          Approve by itself: invites and follow-up messages that pass all checks are approved
          without asking you (replies and anything that fails a check always wait for you).
        </label>
        <div className="muted small">
          Invites today: at most {String(data.invite_day_target?.value ?? '?')} (invites per 7 days
          divided by your send days, varied ±20 % per day, never above the daily limit).
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Send times for invites and messages</h2>
        <div className="muted small">
          Invites, messages and withdrawals are only sent inside these windows (Berlin time).
          Sending itself starts once the messaging step is built and you press “Send approved”.
        </div>
        <Schedule s={data} save={save} />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Limits</h2>
        <NumberField
          label="Invites per day"
          k="daily_invite_cap"
          s={data}
          save={save}
          min={0}
          max={40}
        />
        <NumberField
          label="Invites per 7 days"
          k="weekly_invite_cap"
          s={data}
          save={save}
          min={0}
          max={150}
          help="rolling"
        />
        <NumberField
          label="Messages per day"
          k="daily_message_cap"
          s={data}
          save={save}
          min={0}
          max={100}
        />
        <NumberField
          label="Max pending invites"
          k="pending_invite_cap"
          s={data}
          save={save}
          min={50}
          max={1000}
          help="no new invites above this"
        />
        <NumberField
          label="Withdraw invites after (days)"
          k="withdraw_after_days"
          s={data}
          save={save}
          min={14}
          max={120}
        />
        <NumberField
          label="Auto-posted comments per day"
          k="comment_autopost_daily_max"
          s={data}
          save={save}
          min={0}
          max={10}
        />
        <NumberField
          label="AI budget per day (USD)"
          k="ai_daily_budget_usd"
          s={data}
          save={save}
          min={0}
          max={20}
        />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Robot hours and pace</h2>
        <label className="row between small">
          <span>Robot works between (hours, Berlin)</span>
          <span className="row" style={{ gap: 6 }}>
            <input
              type="number"
              min={0}
              max={23}
              value={hours.from}
              style={{ width: 60 }}
              onChange={(e) => setHours({ ...hours, from: Number(e.target.value) })}
            />
            –
            <input
              type="number"
              min={1}
              max={24}
              value={hours.to}
              style={{ width: 60 }}
              onChange={(e) => setHours({ ...hours, to: Number(e.target.value) })}
            />
            <button className="btn" onClick={() => void save('job_hours', hours, 'Robot hours')}>
              Save
            </button>
          </span>
        </label>
        <label className="row between small">
          <span>Pause between two robot jobs (minutes)</span>
          <span className="row" style={{ gap: 6 }}>
            <input
              type="number"
              min={1}
              max={60}
              value={gap.min}
              style={{ width: 60 }}
              onChange={(e) => setGap({ ...gap, min: Number(e.target.value) })}
            />
            –
            <input
              type="number"
              min={1}
              max={120}
              value={gap.max}
              style={{ width: 60 }}
              onChange={(e) => setGap({ ...gap, max: Number(e.target.value) })}
            />
            <button
              className="btn"
              onClick={() =>
                void save(
                  'job_gap_seconds',
                  { min: gap.min * 60, max: gap.max * 60 },
                  'Pause between jobs',
                )
              }
            >
              Save
            </button>
          </span>
        </label>
        <label className="row between small">
          <span>Automatic comment rounds at (Berlin)</span>
          <span className="row" style={{ gap: 6 }}>
            <input
              value={roundTimes}
              placeholder="11:20, 16:40"
              style={{ width: 130 }}
              onChange={(e) => setRoundTimes(e.target.value)}
            />
            <button
              className="btn"
              onClick={() =>
                void save(
                  'comment_round_times',
                  roundTimes.split(/[,\s]+/).filter(Boolean),
                  'Comment round times',
                )
              }
            >
              Save
            </button>
          </span>
        </label>
        <div className="muted small">
          Automatic rounds also need “Automatic” ticked in the Comments tab.
        </div>
      </div>

      <PromptsAndRules refreshKey={refreshKey} toast={toast} />
    </div>
  );
}

// ---------- Prompts & rules ----------

interface Texts {
  docs: { key: string; version: number; content: string; updated_at: string; by: string }[];
  prompts: {
    task: string;
    version: number;
    model: string;
    system_prompt: string;
    user_template: string;
    note: string | null;
    versions: number;
  }[];
}

const DOC_LABEL: Record<string, string> = {
  engagement_rules: 'Comment rules (which posts, how comments are written)',
  voice_rules: 'Voice rules for messages',
  banned_phrases: 'Banned phrases (never used in any draft)',
  target_groups: 'Target groups',
  targeting_rules: 'Targeting rules (who fits)',
  trigger_rules: 'Trigger rules (what a first message may refer to)',
  reply_rules: 'Reply rules',
  prospecting_keywords: 'Prospecting keywords',
  browsing_conduct: 'Browsing conduct (pace on LinkedIn)',
  signal_playbook: 'Opening playbook (which website fact a message opens with)',
};
const PROMPT_LABEL: Record<string, string> = {
  engagement_pick: 'Comment ideas: picking posts and writing comments',
  comment_factcheck: 'Fact check before posting a comment',
  voice_profile: 'Voice profile (describing how you write)',
  profile_check: 'Profile check (rewrites for your profile)',
  fit_check: 'Fit check (does a person fit a campaign)',
  trigger_extract: 'Trigger search (what a first message may refer to)',
  invite_note: 'Invite note (the personal part of a connection request)',
  message_opener: 'Opening of the first message (from a website fact)',
  classify_reply: 'Sorting replies (interested, question, later, no, …)',
  draft_reply: 'Drafting answers to replies',
};

function DocEditor({
  d,
  toast,
  reload,
}: {
  d: Texts['docs'][number];
  toast: (m: string) => void;
  reload: () => void;
}) {
  const [text, setText] = useState(d.content);
  useEffect(() => setText(d.content), [d.content]);
  const save = async () => {
    try {
      const r = await panelPost<{ version: number }>(`/panel/texts/doc/${d.key}`, {
        content: text,
      });
      toast(`Saved as version ${r.version}. New drafts use it.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="card">
      <summary>
        <strong>{DOC_LABEL[d.key] ?? d.key}</strong>{' '}
        <span className="muted small">
          v{d.version} · {d.by}
        </span>
      </summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <textarea value={text} rows={14} onChange={(e) => setText(e.target.value)} />
        <div className="actions">
          <button className="btn primary" disabled={text === d.content} onClick={() => void save()}>
            Save as new version
          </button>
          <button className="btn" disabled={text === d.content} onClick={() => setText(d.content)}>
            Undo changes
          </button>
        </div>
      </div>
    </details>
  );
}

function PromptEditor({
  p,
  toast,
  reload,
}: {
  p: Texts['prompts'][number];
  toast: (m: string) => void;
  reload: () => void;
}) {
  const [sys, setSys] = useState(p.system_prompt);
  const [tpl, setTpl] = useState(p.user_template);
  useEffect(() => {
    setSys(p.system_prompt);
    setTpl(p.user_template);
  }, [p.system_prompt, p.user_template]);
  const changed = sys !== p.system_prompt || tpl !== p.user_template;
  const save = async () => {
    try {
      const r = await panelPost<{ version: number }>(`/panel/texts/prompt/${p.task}`, {
        system_prompt: sys,
        user_template: tpl,
      });
      toast(`Prompt saved as version ${r.version} and in use.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const revert = async () => {
    if (!confirm('Go back to the previous version of this prompt?')) return;
    try {
      const r = await panelPost<{ version: number }>(`/panel/texts/prompt/${p.task}/revert`, {});
      toast(`Back to version ${r.version}.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="card">
      <summary>
        <strong>{PROMPT_LABEL[p.task] ?? p.task}</strong>{' '}
        <span className="muted small">
          v{p.version} of {p.versions} · {p.model}
        </span>
      </summary>
      <div className="stack small" style={{ marginTop: 8 }}>
        <span className="muted">Instructions to the AI</span>
        <textarea value={sys} rows={16} onChange={(e) => setSys(e.target.value)} />
        <span className="muted">
          Message template: keep the {'{{placeholders}}'} as they are; LinkedIn text stays inside
          &lt;page_data&gt;.
        </span>
        <textarea value={tpl} rows={6} onChange={(e) => setTpl(e.target.value)} />
        <div className="actions">
          <button className="btn primary" disabled={!changed} onClick={() => void save()}>
            Save and use
          </button>
          <button
            className="btn"
            disabled={!changed}
            onClick={() => {
              setSys(p.system_prompt);
              setTpl(p.user_template);
            }}
          >
            Undo changes
          </button>
          <button
            className="btn"
            disabled={p.versions < 2 || changed}
            onClick={() => void revert()}
          >
            Previous version
          </button>
        </div>
      </div>
    </details>
  );
}

export function PromptsAndRules({
  refreshKey,
  toast,
}: {
  refreshKey: number;
  toast: (m: string) => void;
}) {
  const { data, error, reload } = useData<Texts>('/panel/texts', refreshKey);
  if (!data) return <div className="card empty">{error ?? 'Loading…'}</div>;
  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Prompts &amp; rules</h2>
        <div className="muted small">
          Change how comments, messages and checks are written. Every save is a new version; old
          versions are kept. Fixed checks in code (banned phrases, no emoji or links, Sie-form in
          messages, length, verified quotes) always apply on top.
        </div>
      </div>
      <h2 style={{ margin: '4px 0 0' }}>Your rule texts</h2>
      {data.docs.map((d) => (
        <DocEditor key={d.key} d={d} toast={toast} reload={reload} />
      ))}
      <h2 style={{ margin: '4px 0 0' }}>AI prompts</h2>
      {data.prompts.map((p) => (
        <PromptEditor key={p.task} p={p} toast={toast} reload={reload} />
      ))}
    </div>
  );
}
