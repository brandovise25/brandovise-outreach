import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { sendToWorker, type Status, type UiRequest } from '../../lib/messages.ts';
import { StatusCard } from '../../lib/StatusCard.tsx';
import {
  DEFAULT_SERVER_URL,
  LOCAL_SERVER_URL,
  normalizeServerUrl,
  originPattern,
} from '../../lib/config.ts';

const page = {
  fontFamily: 'system-ui, sans-serif',
  maxWidth: 520,
  margin: '2rem auto',
  padding: '0 1rem',
};
const section = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: '0.75rem 1rem',
  margin: '1rem 0',
};

function Options() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ping, setPing] = useState<string | null>(null);
  const [choice, setChoice] = useState<'local' | 'server'>('local');
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER_URL);

  const run = async (req: UiRequest) => {
    setBusy(true);
    setError(null);
    try {
      const res = await sendToWorker(req);
      if (!res.ok) setError(res.error);
      else {
        if (res.status) setStatus(res.status);
        if (res.result) setPing(JSON.stringify(res.result, null, 2));
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void sendToWorker({ type: 'status' }).then((res) => {
      if (!res.ok || !res.status) return;
      setStatus(res.status);
      if (res.status.apiUrl && res.status.apiUrl !== LOCAL_SERVER_URL) {
        setChoice('server');
        setServerInput(res.status.apiUrl);
      }
    });
  }, []);

  // Host permission must be requested from a page with a user gesture, so it happens here.
  const saveServer = async () => {
    setError(null);
    let url: string;
    try {
      url = normalizeServerUrl(choice === 'local' ? LOCAL_SERVER_URL : serverInput);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const granted = await browser.permissions.request({ origins: [originPattern(url)] });
    if (!granted) {
      setError('Chrome did not grant access to this server.');
      return;
    }
    await run({ type: 'setServer', url });
  };

  const onLogin = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run({ type: 'login', email: String(f.get('email')), password: String(f.get('password')) });
  };

  return (
    <main style={page}>
      <h1>Brandovise Outreach</h1>
      {status && <StatusCard status={status} />}
      {error && (
        <p role="alert" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}

      <section style={section} aria-label="Server">
        <h2 style={{ fontSize: '1rem' }}>Server</h2>
        <p>
          <label>
            <input type="radio" checked={choice === 'local'} onChange={() => setChoice('local')} />{' '}
            Local (Docker on this Mac, {LOCAL_SERVER_URL})
          </label>
        </p>
        <p>
          <label>
            <input
              type="radio"
              checked={choice === 'server'}
              onChange={() => setChoice('server')}
            />{' '}
            Server{' '}
            <input
              type="url"
              placeholder="https://outreach.example.com"
              value={serverInput}
              onChange={(e) => {
                setServerInput(e.currentTarget.value);
                setChoice('server');
              }}
              style={{ width: '18rem' }}
            />
          </label>
        </p>
        <button disabled={busy} onClick={() => void saveServer()}>
          Use this server
        </button>
        <p style={{ color: '#555', fontSize: '0.85rem' }}>
          Switching servers signs you out of the old one.
        </p>
      </section>

      {status?.apiUrl && !status.signedIn && (
        <section style={section}>
          <form onSubmit={onLogin} aria-label="Sign in">
            <h2 style={{ fontSize: '1rem' }}>Sign in to {status.apiUrl}</h2>
            <p>
              <label>
                Email <input name="email" type="email" autoComplete="username" required />
              </label>
            </p>
            <p>
              <label>
                Password{' '}
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
            </p>
            <button disabled={busy}>Sign in</button>
          </form>
        </section>
      )}

      {status?.signedIn && (
        <section style={section}>
          <p>
            <label>
              Device name{' '}
              <input
                defaultValue={status.deviceName}
                onBlur={(e) => void run({ type: 'setDeviceName', name: e.currentTarget.value })}
              />
            </label>
          </p>
          <p>
            <button disabled={busy} onClick={() => void run({ type: 'aiPing' })}>
              Test AI connection
            </button>{' '}
            <button disabled={busy} onClick={() => void run({ type: 'logout' })}>
              Sign out
            </button>
          </p>
          {ping && <pre>{ping}</pre>}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
