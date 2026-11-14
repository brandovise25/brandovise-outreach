import { sendToWorker, type Status, type UiResponse } from '../../lib/messages.ts';

// The side panel is a frame around the web app served by the API server (<server>/app/), so the UI
// deploys with the server. This page only answers the app's few requests that need the extension.

const root = document.getElementById('root')!;

function message(text: string, button?: { label: string; action: () => void }) {
  root.replaceChildren();
  const box = document.createElement('div');
  box.className = 'msg';
  box.textContent = text;
  if (button) {
    const b = document.createElement('button');
    b.textContent = button.label;
    b.onclick = button.action;
    box.append(document.createElement('br'), b);
  }
  root.append(box);
}

async function workerStatus(): Promise<Status | null> {
  const res = await sendToWorker({ type: 'status' });
  return res.ok ? (res.status ?? null) : null;
}

function unwrap(res: UiResponse): unknown {
  if (!res.ok) throw new Error(res.error);
  return res.result ?? res.status;
}

async function handle(type: string, data: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case 'token':
      return unwrap(await sendToWorker({ type: 'token' }));
    case 'status': {
      const s = await workerStatus();
      return (
        s && { dryRun: s.dryRun, paused: s.paused, lastError: s.lastError, version: s.version }
      );
    }
    case 'runJobs':
      return unwrap(await sendToWorker({ type: 'runJobs' }));
    case 'stopRobot':
      return unwrap(await sendToWorker({ type: 'stopRobot' }));
    case 'showRobot':
      return unwrap(await sendToWorker({ type: 'showRobot' }));
    case 'commentRoundStatus':
      return unwrap(await sendToWorker({ type: 'commentRoundStatus' }));
    case 'getShowWindows':
      return unwrap(await sendToWorker({ type: 'getShowWindows' }));
    case 'setShowWindows':
      return unwrap(await sendToWorker({ type: 'setShowWindows', on: data.on === true }));
    case 'getRobotSurface':
      return unwrap(await sendToWorker({ type: 'getRobotSurface' }));
    case 'setRobotSurface':
      return unwrap(
        await sendToWorker({
          type: 'setRobotSurface',
          surface: data.surface === 'window' ? 'window' : 'tab',
        }),
      );
    case 'postStatus':
      return unwrap(await sendToWorker({ type: 'postStatus' }));
    case 'setRoundSchedule':
      return unwrap(await sendToWorker({ type: 'setRoundSchedule', on: data.on === true }));
    case 'openTab': {
      const url = String(data.url ?? '');
      if (!/^https:\/\//.test(url)) throw new Error('only https links');
      await browser.tabs.create({ url, active: true });
      return true;
    }
    case 'openOptions':
      await browser.runtime.openOptionsPage();
      return true;
    default:
      throw new Error(`unknown request ${type}`);
  }
}

async function start() {
  const status = await workerStatus();
  if (!status?.apiUrl) {
    return message('Choose a server and sign in on the settings page.', {
      label: 'Open settings',
      action: () => void browser.runtime.openOptionsPage(),
    });
  }
  const server = new URL(status.apiUrl).origin;
  try {
    const r = await fetch(`${server}/health`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    return message(`The server ${server} is not reachable.`, {
      label: 'Try again',
      action: () => void start(),
    });
  }

  const frame = document.createElement('iframe');
  frame.src = `${server}/app/?ext=${encodeURIComponent(location.origin)}`;
  frame.allow = 'clipboard-write';
  frame.title = 'Brandovise Outreach';
  root.replaceChildren(frame);

  window.onmessage = (e: MessageEvent) => {
    // Only the app page we loaded, from the configured server, may ask.
    if (e.origin !== server || e.source !== frame.contentWindow) return;
    const { id, type, ...data } = (e.data ?? {}) as { id?: number; type?: string } & Record<
      string,
      unknown
    >;
    if (typeof id !== 'number' || typeof type !== 'string') return;
    handle(type, data).then(
      (result) => frame.contentWindow?.postMessage({ id, ok: true, result }, server),
      (err: unknown) =>
        frame.contentWindow?.postMessage(
          { id, ok: false, error: err instanceof Error ? err.message : String(err) },
          server,
        ),
    );
  };
}

// Server changed, or signed in/out, on the settings page: reload the frame. A token refresh (same
// signed-in state) must not reload it.
browser.storage.onChanged.addListener((changes) => {
  const auth = changes['auth.tokens'];
  const signInChanged = auth && !!auth.oldValue !== !!auth.newValue;
  if (changes['server.url'] || signInChanged) void start();
});
void start();
