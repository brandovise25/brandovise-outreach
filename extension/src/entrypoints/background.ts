import { ApiClient } from '@outreach/shared';
import { chromeStore } from '../lib/chrome-store.ts';
import { SERVER_URL_KEY, normalizeServerUrl } from '../lib/config.ts';
import { UiRequest, type Status, type UiResponse } from '../lib/messages.ts';
import {
  ROUND_SCHEDULE_KEY,
  ROUND_TIMES,
  maybeRunScheduled,
  maybeAutoSync,
  onScrollProgress,
  roundStatus,
} from '../lib/round.ts';
import { postStatus } from '../lib/post.ts';
import { maybeAutoProspect, maybeAutoSend } from '../lib/auto.ts';
import { runNextJob } from '../lib/jobs.ts';
import { currentRun } from '../lib/job-run.ts';
import { refreshLoginState, reportLogin } from '../lib/linkedin-login.ts';
import { markSignOutOnPurpose, watchAppLogin } from '../lib/app-login.ts';
import {
  SHOW_ROBOT_KEY,
  SURFACE_KEY,
  currentRobotTab,
  robotSurface,
  showRobot,
} from '../lib/robot-tab.ts';

const HEARTBEAT_ALARM = 'heartbeat';
const STATE_KEY = 'worker.state';
const ROUND_ALARM = 'commentRound';
const JOBS_ALARM = 'jobs';

interface WorkerState {
  deviceName: string;
  lastHeartbeat: string | null;
  lastError: string | null;
  dryRun: boolean | null;
  paused: boolean | null;
}

export default defineBackground(() => {
  const version = browser.runtime.getManifest().version;
  const serverUrl = async () => (await chromeStore.get<string>(SERVER_URL_KEY)) ?? '';
  const api = new ApiClient(serverUrl, version, chromeStore);

  async function getState(): Promise<WorkerState> {
    return (
      (await chromeStore.get<WorkerState>(STATE_KEY)) ?? {
        deviceName: 'Chrome',
        lastHeartbeat: null,
        lastError: null,
        dryRun: null,
        paused: null,
      }
    );
  }
  async function patchState(patch: Partial<WorkerState>) {
    await chromeStore.set(STATE_KEY, { ...(await getState()), ...patch });
  }

  async function heartbeat() {
    if (!(await api.isSignedIn())) return;
    const state = await getState();
    try {
      await api.heartbeat({
        name: state.deviceName,
        version,
        userAgent: navigator.userAgent,
        lastError: state.lastError,
      });
      const settings = await api.settings();
      await patchState({
        lastHeartbeat: new Date().toISOString(),
        lastError: null,
        dryRun: settings.ext_dry_run,
        paused: settings.paused,
      });
    } catch (err) {
      await patchState({ lastError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function status(): Promise<Status> {
    const s = await getState();
    return { signedIn: await api.isSignedIn(), apiUrl: await serverUrl(), version, ...s };
  }

  async function handle(raw: unknown): Promise<UiResponse> {
    const req = UiRequest.parse(raw);
    switch (req.type) {
      case 'status':
        return { ok: true, status: await status() };
      case 'login':
        await api.login(req.email, req.password);
        await heartbeat();
        return { ok: true, status: await status() };
      case 'logout':
        await markSignOutOnPurpose();
        await api.logout();
        await patchState({ lastHeartbeat: null, dryRun: null, paused: null });
        return { ok: true, status: await status() };
      case 'setDeviceName':
        await patchState({ deviceName: req.name.trim() || 'Chrome' });
        await heartbeat();
        return { ok: true, status: await status() };
      case 'setServer': {
        // The options page has already obtained the host permission for this origin.
        const url = normalizeServerUrl(req.url);
        if (url !== (await serverUrl())) {
          // Tokens belong to one server; never send them to another.
          await markSignOutOnPurpose();
          await api.forgetTokens();
          await chromeStore.set(SERVER_URL_KEY, url);
          await patchState({ lastHeartbeat: null, lastError: null, dryRun: null, paused: null });
        }
        return { ok: true, status: await status() };
      }
      case 'runJobs':
        // The app queued a job on the server: start it now instead of at the next minute alarm.
        void runNextJob(roundDeps);
        return { ok: true, result: true };
      case 'stopRobot': {
        const run = currentRun();
        run?.stop('Stopped from the app.');
        await currentRobotTab()
          ?.send({ type: 'stopScroll' })
          .catch(() => undefined);
        return { ok: true, result: !!run };
      }
      case 'showRobot': {
        const tab = currentRobotTab();
        await tab?.show();
        return { ok: true, result: !!tab };
      }
      case 'commentRoundStatus':
        return {
          ok: true,
          result: {
            ...(await roundStatus(chromeStore)),
            schedule: (await chromeStore.get<boolean>(ROUND_SCHEDULE_KEY)) === true,
            times: (await api.settings().catch(() => null))?.comment_round_times ?? ROUND_TIMES,
          },
        };
      case 'getShowWindows':
        return { ok: true, result: await showRobot() };
      case 'setShowWindows':
        await chromeStore.set(SHOW_ROBOT_KEY, req.on);
        return { ok: true, result: req.on };
      case 'getRobotSurface':
        return { ok: true, result: await robotSurface() };
      case 'setRobotSurface':
        await chromeStore.set(SURFACE_KEY, req.surface);
        return { ok: true, result: req.surface };
      case 'postStatus':
        return { ok: true, result: await postStatus(chromeStore) };
      case 'setRoundSchedule':
        await chromeStore.set(ROUND_SCHEDULE_KEY, req.on);
        return { ok: true, result: req.on };
      case 'token':
        // The web app in the side panel asks for an access token; the refresh token never leaves here.
        return { ok: true, result: await api.accessToken() };
      case 'aiPing':
        return { ok: true, result: await api.ai('ping', { word: 'hello' }) };
    }
  }

  // Only our own extension pages (options, side panel) may use this channel. Content scripts run on
  // linkedin.com URLs and get their own channel later. The options page has sender.tab set, so the
  // check is on the page URL, not on the tab.
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (
      sender.id !== browser.runtime.id ||
      !sender.url ||
      new URL(sender.url).origin !== extensionOrigin
    ) {
      return false;
    }
    handle(msg)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  });

  // Content scripts may only send these message types; everything else stays page-only.
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (
      sender.id !== browser.runtime.id ||
      !sender.tab?.url?.startsWith('https://www.linkedin.com/')
    )
      return false;
    const m = msg as { type?: string; posts?: unknown; steps?: unknown; loggedIn?: unknown };
    if (m?.type === 'linkedinLogin' && typeof m.loggedIn === 'boolean')
      void reportLogin(m.loggedIn);
    if (
      m?.type === 'scrollProgress' &&
      typeof m.posts === 'number' &&
      typeof m.steps === 'number'
    ) {
      void onScrollProgress(m.posts, m.steps);
    }
    return false;
  });

  const roundDeps = {
    api,
    store: chromeStore,
    onWarning: async (text: string) => {
      await patchState({ lastError: text });
      await browser.notifications.create(`warn-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: 'Brandovise Outreach stopped',
        message: `${text}. Nothing more runs on LinkedIn until you check.`,
      });
    },
  };
  browser.alarms.create(ROUND_ALARM, { periodInMinutes: 5 });
  browser.alarms.create(JOBS_ALARM, { periodInMinutes: 1 });

  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 5 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) void heartbeat();
    if (alarm.name === ROUND_ALARM) {
      void maybeRunScheduled(roundDeps);
      void maybeAutoSync(roundDeps);
      // A failing timer used to stop without a trace; now the reason shows as "Connection problem".
      for (const auto of [maybeAutoSend, maybeAutoProspect])
        void auto(roundDeps).catch((err: unknown) =>
          patchState({
            lastError: `Schedule stopped: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
    }
    if (alarm.name === JOBS_ALARM) void runNextJob(roundDeps);
  });
  // A job cut off by a reload or browser restart must not stay "running" forever.
  void (async () => {
    for (const key of ['round.status', 'post.status']) {
      const st = await chromeStore.get<{ state?: string; message?: string }>(key);
      if (st?.state === 'running')
        await chromeStore.set(key, {
          ...st,
          state: 'error',
          message: 'Interrupted (extension restarted).',
        });
    }
  })();
  browser.runtime.onStartup.addListener(() => void heartbeat());
  browser.runtime.onInstalled.addListener(() => void heartbeat());

  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void refreshLoginState();
  watchAppLogin();
});
