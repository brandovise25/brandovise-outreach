import { useCallback, useEffect, useState } from 'react';
import { ago, panelGet, panelPost } from './api.ts';
import { askExtension, embedded } from './bridge.ts';

// The robot bar (top of every tab) and the job log: what the robot is doing right now, step by step.

export const JOB_LABEL: Record<string, string> = {
  comment_round: 'Comment round',
  post_comment: 'Posting a comment',
  capture_sync: 'Saving pages',
  prospect_round: 'Finding prospects',
  import_leads: 'Researching imported leads',
  company_lookup: 'Looking up company owners',
  sync_round: 'Syncing LinkedIn',
  send_round: 'Sending approved',
};

interface LogLine {
  id: number;
  job_id?: number;
  kind?: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  step: string | null;
  message: string;
}
interface Robot {
  now: string;
  next_after: string | null;
  running: null | {
    id: number;
    kind: string;
    created_by: string;
    started_at: string;
    progress: Record<string, unknown>;
    stop_requested: boolean;
    events: LogLine[];
  };
  queued: { id: number; kind: string; not_before: string }[];
  last: null | {
    id: number;
    kind: string;
    status: string;
    finished_at: string;
    result: { message?: string } | null;
  };
}

// Queues a job on the server and asks the extension (when the app runs in its side panel) to start it
// now instead of at its next one-minute check.
export async function startJob(kind: string, params: Record<string, unknown> = {}) {
  const r = await panelPost<{ id: number }>('/panel/jobs', { kind, params });
  if (embedded) void askExtension('runJobs').catch(() => undefined);
  window.dispatchEvent(new Event('robot:changed'));
  return r.id;
}

// Waits until a job has finished; reports its latest log line meanwhile.
export async function waitForJob(id: number, onStep: (m: string) => void, maxMs = 15 * 60_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2000));
    const robot = await panelGet<Robot>('/panel/robot');
    if (robot.running?.id === id) {
      onStep(robot.running.events[0]?.message ?? 'Working…');
      continue;
    }
    if (robot.queued.some((q) => q.id === id)) {
      onStep(robot.running ? 'Waiting for the robot to finish its current job…' : 'Starting…');
      continue;
    }
    const jobs =
      await panelGet<{ id: number; status: string; result: { message?: string } }[]>('/panel/jobs');
    const j = jobs.find((x) => x.id === id);
    return { status: j?.status ?? 'unknown', message: j?.result?.message ?? '' };
  }
  return { status: 'unknown', message: 'Still running; see the log.' };
}

function progressText(p: Record<string, unknown>): string {
  const parts: string[] = [];
  const pair = (a: string, b: string, label: string) => {
    if (typeof p[a] === 'number')
      parts.push(
        `${label} ${p[a] as number}${typeof p[b] === 'number' ? `/${p[b] as number}` : ''}`,
      );
  };
  pair('profiles', 'maxProfiles', 'profiles');
  pair('pageLoads', 'maxPageLoads', 'pages');
  pair('pages', 'maxPages', 'pages');
  pair('posts', 'targetPosts', 'posts');
  pair('candidates', '', 'leads');
  pair('items', 'maxItems', 'items');
  return parts.join(' · ');
}

function Countdown({ until }: { until: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.round((Date.parse(until) - Date.now()) / 1000);
  return s > 0 ? <span className="badge">next step in {s} s</span> : null;
}

export function RobotBar({ onOpenLog }: { onOpenLog: () => void }) {
  const [robot, setRobot] = useState<Robot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    panelGet<Robot>('/panel/robot').then(
      (r) => (setRobot(r), setError(null)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  // Every 2 s while a job runs or waits, every 15 s otherwise.
  const busy = !!robot?.running || (robot?.queued.length ?? 0) > 0;
  useEffect(() => {
    load();
    const t = setInterval(load, busy ? 2000 : 15000);
    window.addEventListener('robot:changed', load);
    return () => (clearInterval(t), window.removeEventListener('robot:changed', load));
  }, [load, busy]);

  if (error) return <div className="robot small error">Robot status unavailable: {error}</div>;
  if (!robot) return null;
  const r = robot.running;
  if (!r) {
    const l = robot.last;
    return (
      <div className="robot idle small">
        <span className="dot idle" />
        <span className="grow clip">
          {robot.queued.length > 0 &&
          robot.next_after &&
          Date.parse(robot.next_after) > Date.parse(robot.now)
            ? `Pause between jobs until ${new Date(robot.next_after).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, then: ${robot.queued.map((q) => JOB_LABEL[q.kind] ?? q.kind).join(', ')}`
            : robot.queued.length > 0
              ? `Waiting to start: ${robot.queued.map((q) => JOB_LABEL[q.kind] ?? q.kind).join(', ')}`
              : l
                ? `Idle · last: ${JOB_LABEL[l.kind] ?? l.kind} ${l.status === 'done' ? '✓' : l.status} ${ago(l.finished_at) === 'now' ? 'just now' : `${ago(l.finished_at)} ago`}${l.result?.message ? ` – ${l.result.message}` : ''}`
                : 'Idle'}
        </span>
        <button className="btn link" onClick={onOpenLog}>
          Log
        </button>
      </div>
    );
  }
  const wait = typeof r.progress.waitUntil === 'string' ? r.progress.waitUntil : null;
  const prog = progressText(r.progress);
  return (
    <div className="robot running">
      <div className="row between" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="dot live" />
          <strong>{JOB_LABEL[r.kind] ?? r.kind}</strong>
          <span className="muted small">{ago(r.started_at)}</span>
        </span>
        <span className="row" style={{ gap: 6 }}>
          {embedded && (
            <button className="btn" onClick={() => void askExtension('showRobot')}>
              Show tab
            </button>
          )}
          <button
            className="btn danger"
            disabled={r.stop_requested}
            onClick={() => {
              void panelPost(`/panel/jobs/${r.id}/stop`, {}).then(load);
              if (embedded) void askExtension('stopRobot').catch(() => undefined);
            }}
          >
            {r.stop_requested ? 'Stopping…' : 'Stop'}
          </button>
        </span>
      </div>
      <div className="small">{r.events[0]?.message ?? 'Starting…'}</div>
      {(prog || wait) && (
        <div className="row small muted" style={{ gap: 6, flexWrap: 'wrap' }}>
          {prog && <span>{prog}</span>}
          {wait && <Countdown until={wait} />}
        </div>
      )}
      <ol className="robot-lines small muted">
        {r.events.slice(1, 5).map((e) => (
          <li key={e.id} className={e.level}>
            {e.message}
          </li>
        ))}
      </ol>
      <button className="btn link small" onClick={onOpenLog}>
        Full log ›
      </button>
    </div>
  );
}

export function JobLog({ refreshKey }: { refreshKey: number }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<number | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const load = useCallback(() => {
    panelGet<LogLine[]>(`/panel/job-events?limit=400${job ? `&job=${job}` : ''}`).then(
      setLines,
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [job]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  if (!lines) return <div className="card empty">{error ?? 'Loading…'}</div>;
  const shown = lines.filter((l) => !problemsOnly || l.level !== 'info');
  // Group consecutive lines by job.
  const groups: { job: number; kind: string; lines: LogLine[] }[] = [];
  for (const l of shown) {
    const g = groups[groups.length - 1];
    if (g && g.job === l.job_id) g.lines.push(l);
    else groups.push({ job: l.job_id ?? 0, kind: l.kind ?? '', lines: [l] });
  }
  return (
    <div className="stack">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {job && (
          <button className="btn" onClick={() => setJob(null)}>
            All jobs
          </button>
        )}
        <label className="row small" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={problemsOnly}
            onChange={() => setProblemsOnly((v) => !v)}
          />
          Warnings and errors only
        </label>
      </div>
      {!groups.length && <div className="card empty">Nothing logged yet.</div>}
      {groups.map((g) => (
        <div key={`${g.job}-${g.lines[0]!.id}`} className="card">
          <div className="row between">
            <button className="btn link" onClick={() => setJob(g.job)}>
              <strong>{JOB_LABEL[g.kind] ?? g.kind}</strong> #{g.job}
            </button>
            <span className="muted small">{new Date(g.lines[0]!.at).toLocaleString()}</span>
          </div>
          <div className="timeline">
            {g.lines.map((l) => (
              <div key={l.id} className={`tl ${l.level}`}>
                <span className="t">
                  {new Date(l.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <div className={`small ${l.level === 'error' ? 'error-text' : ''}`}>
                  {l.level !== 'info' && (
                    <span className={`badge ${l.level === 'error' ? 'bad' : 'warn'}`}>
                      {l.level}
                    </span>
                  )}{' '}
                  {l.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
