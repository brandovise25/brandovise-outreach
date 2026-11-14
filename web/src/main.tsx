import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { login, logout, panelGet, signInProblem } from './api.ts';
import { askExtension, embedded } from './bridge.ts';
import { Activity, Approve, CampaignsTab, Comments, Leads, Today } from './views.tsx';
import { JobLog, RobotBar, startJob, waitForJob } from './robot.tsx';
import { Voice } from './voice.tsx';
import { SettingsTab } from './settings.tsx';

type Tab =
  | 'today'
  | 'approve'
  | 'leads'
  | 'comments'
  | 'campaigns'
  | 'voice'
  | 'settings'
  | 'activity'
  | 'log';
interface Counts {
  approve: number;
  leads: number;
  comments: number;
}
// What the extension reports about itself when the app runs in its side panel.
interface ExtStatus {
  dryRun: boolean | null;
  paused: boolean | null;
  lastError: string | null;
  version: string;
  local: boolean;
}

function Login({ onDone, problem }: { onDone: () => void; problem: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (embedded) {
    return (
      <div className="card stack" style={{ margin: 12 }}>
        <h2>Not signed in</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Sign in on the extension's settings page.
        </p>
        {problem && problem !== 'not signed in' && (
          <div className="error">Extension said: {problem}</div>
        )}
        <div className="actions">
          <button className="btn primary" onClick={() => void askExtension('openOptions')}>
            Open settings
          </button>
          <button className="btn" onClick={onDone}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await login(String(f.get('email')), String(f.get('password')));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card stack"
      style={{ margin: '48px auto', maxWidth: 360 }}
      onSubmit={submit}
      aria-label="Sign in"
    >
      <h2>Brandovise Outreach</h2>
      <label className="stack small">
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label className="stack small">
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="btn primary" disabled={busy}>
          Sign in
        </button>
      </div>
    </form>
  );
}

function Developer({ toast }: { toast: (m: string) => void }) {
  const [status, setStatus] = useState<string | null>(null);
  const start = async () => {
    try {
      const id = await startJob('capture_sync');
      setStatus('Queued…');
      const r = await waitForJob(id, setStatus);
      setStatus(null);
      toast(r.message || r.status);
    } catch (e) {
      setStatus(null);
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="dev card">
      <summary>Developer</summary>
      <p className="muted small">
        Opens the inbox, recent connections and sent invitations one after another in the robot tab
        (about 1–2 minutes), saves each page into the project on this Mac (local server only, not in
        git) and closes the tab. Nothing is clicked.
      </p>
      <div className="actions">
        <button className="btn" disabled={!!status} onClick={() => void start()}>
          Capture sync pages
        </button>
      </div>
      {status && <div className="small muted">{status}</div>}
    </details>
  );
}

// Where the robot works and whether it is visible. Shown on Today, side panel only.
function RobotSettings({ toast }: { toast: (m: string) => void }) {
  const [show, setShow] = useState<boolean | null>(null);
  const [surface, setSurface] = useState<'tab' | 'window' | null>(null);
  useEffect(() => {
    void askExtension<boolean>('getShowWindows').then(setShow, () => setShow(null));
    void askExtension<'tab' | 'window'>('getRobotSurface').then(setSurface, () => setSurface(null));
  }, []);
  if (show === null || surface === null) return null;
  return (
    <details className="dev card">
      <summary>Robot tab settings</summary>
      <div className="stack small" style={{ marginTop: 8 }}>
        <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={show}
            onChange={() => {
              const on = !show;
              void askExtension('setShowWindows', { on }).then(() => {
                setShow(on);
                toast(
                  on ? 'The robot tab opens in front.' : 'The robot tab opens in the background.',
                );
              });
            }}
          />
          Open the robot tab in front (to watch)
        </label>
        <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={surface === 'window'}
            onChange={() => {
              const next = surface === 'window' ? 'tab' : 'window';
              void askExtension('setRobotSurface', { surface: next }).then(() => {
                setSurface(next);
                toast(next === 'tab' ? 'Robot uses a tab.' : 'Robot uses a separate window.');
              });
            }}
          />
          Use a separate window instead of a tab (if pages do not load in a background tab)
        </label>
        <span className="muted">
          The robot opens its own tab (group “Brandovise robot”) at the end of your current window
          and closes it when done. It never uses your tabs. Closing the robot tab stops the job.
        </span>
      </div>
    </details>
  );
}

function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ext, setExt] = useState<ExtStatus | null>(null);
  const [tab, setTab] = useState<Tab>('today');
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const refresh = () => setRefreshKey((k) => k + 1);
  const toast = (m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg((cur) => (cur === m ? null : cur)), 4000);
  };

  useEffect(() => {
    void signInProblem().then((p) => {
      setProblem(p);
      setAuth(p === null);
    });
    if (embedded) void askExtension<ExtStatus>('status').then(setExt, () => setExt(null));
  }, [refreshKey]);
  useEffect(() => {
    if (!auth) return;
    panelGet<{ counts: Counts }>('/panel/dashboard').then(
      (d) => setCounts(d.counts),
      () => setCounts(null),
    );
  }, [auth, refreshKey]);
  useEffect(() => {
    const bump = () => document.visibilityState === 'visible' && setRefreshKey((k) => k + 1);
    document.addEventListener('visibilitychange', bump);
    const t = setInterval(bump, 120_000);
    return () => (document.removeEventListener('visibilitychange', bump), clearInterval(t));
  }, []);

  if (auth === null) return <div className="empty">Loading…</div>;
  if (!auth) return <Login onDone={refresh} problem={problem} />;

  const tabs: [Tab, string, number | undefined][] = [
    ['today', 'Today', undefined],
    ['approve', 'Approve', counts?.approve],
    ['leads', 'Leads', counts?.leads],
    ['comments', 'Comments', counts?.comments],
    ['campaigns', 'Campaigns', undefined],
    ['voice', 'Voice', undefined],
    ['settings', 'Settings', undefined],
  ];
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  return (
    <div className={`app ${embedded ? '' : 'standalone'}`}>
      <div className="top">
        <div className="brand">
          <h1>
            <span className={`dot ${ext?.lastError ? 'off' : ''}`} />
            Brandovise Outreach
          </h1>
          <div className="row" style={{ gap: 6 }}>
            {!embedded && (
              <button className="btn" onClick={() => void logout().then(refresh)}>
                Sign out
              </button>
            )}
            <button className="btn" onClick={refresh} title="Refresh">
              ↻
            </button>
          </div>
        </div>
        <div className="pills">
          {ext?.dryRun === false ? (
            <span className="pill bad">Live sending</span>
          ) : (
            <span className="pill ok">Dry run · nothing is sent</span>
          )}
          {ext?.paused && <span className="pill warn">Paused</span>}
          <span className="pill">{local ? 'Local server' : 'Server'}</span>
          {!embedded && <span className="pill">Browser</span>}
          {ext?.lastError && (
            <span className="pill bad" title={ext.lastError}>
              Connection problem: {ext.lastError.slice(0, 60)}
            </span>
          )}
        </div>
        <RobotBar onOpenLog={() => setTab('log')} />
        <div className="tabs" role="tablist">
          {tabs.map(([id, label, n]) => (
            <button
              key={id}
              role="tab"
              className="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
              {n !== undefined && n > 0 && (
                <span className={`n ${id === 'approve' ? 'hot' : ''}`}>{n}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <main>
        {tab === 'today' && <Today refreshKey={refreshKey} onGo={(t) => setTab(t as Tab)} />}
        {tab === 'approve' && (
          <Approve refreshKey={refreshKey} toast={(m) => (toast(m), refresh())} />
        )}
        {tab === 'leads' && <Leads refreshKey={refreshKey} toast={(m) => (toast(m), refresh())} />}
        {tab === 'comments' && (
          <Comments refreshKey={refreshKey} toast={(m) => (toast(m), refresh())} />
        )}
        {tab === 'campaigns' && <CampaignsTab refreshKey={refreshKey} toast={toast} />}
        {tab === 'voice' && <Voice refreshKey={refreshKey} toast={toast} />}
        {tab === 'settings' && <SettingsTab refreshKey={refreshKey} toast={toast} />}
        {tab === 'activity' && (
          <>
            <button className="btn" onClick={() => setTab('today')}>
              ← Today
            </button>
            <Activity refreshKey={refreshKey} />
          </>
        )}
        {tab === 'log' && (
          <>
            <button className="btn" onClick={() => setTab('today')}>
              ← Today
            </button>
            <JobLog refreshKey={refreshKey} />
          </>
        )}
        {tab === 'today' && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => setTab('log')}>
              Robot log ›
            </button>
            <button className="btn" onClick={() => setTab('activity')}>
              Outreach activity ›
            </button>
          </div>
        )}
        {tab === 'today' && embedded && <RobotSettings toast={toast} />}
        {embedded && local && <Developer toast={toast} />}
      </main>
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
