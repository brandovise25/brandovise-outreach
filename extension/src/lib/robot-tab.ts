import type { JobRun } from './job-run.ts';
import { StopRequested } from './job-run.ts';

// The robot's own LinkedIn tab (Jibran, 09.10.2026: "open a tab, not a new browser window").
// Each job opens ONE new tab at the end of Jibran's current Chrome window, in a tab group called
// "Brandovise robot", uses it for all its pages and closes it at the end. It never touches a tab
// Jibran opened. With "Show robot" on, the tab opens in front so he can watch.
// Fallback: robot surface "window" opens a separate unfocused window instead (the old behaviour),
// for pages that do not render in a background tab.

export const SHOW_ROBOT_KEY = 'ui.showWindows'; // kept from the earlier "show windows" option
export const SURFACE_KEY = 'ui.robotSurface';
export type Surface = 'tab' | 'window';

const BLOCKED = /^\/(checkpoint|authwall|uas\/login|login|signup)\b/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function showRobot(): Promise<boolean> {
  const r = await browser.storage.local.get(SHOW_ROBOT_KEY);
  return r[SHOW_ROBOT_KEY] === true;
}
export async function robotSurface(): Promise<Surface> {
  const r = await browser.storage.local.get(SURFACE_KEY);
  return r[SURFACE_KEY] === 'window' ? 'window' : 'tab';
}

let openTab: RobotTab | null = null;
export const currentRobotTab = () => openTab;

export interface PageState {
  ok: boolean;
  path: string;
  visible: string;
  nodes: number;
}

export class RobotTab {
  private closing = false;
  private onRemoved = (id: number) => {
    if (id !== this.tabId || this.closing) return;
    this.closedByUser = true;
    this.run.stop('Stopped: the robot tab was closed.');
  };
  closedByUser = false;

  private constructor(
    private run: JobRun,
    readonly tabId: number,
    readonly windowId: number,
    readonly ownWindow: boolean,
  ) {
    browser.tabs.onRemoved.addListener(this.onRemoved);
  }

  static async open(run: JobRun, url: string): Promise<RobotTab> {
    const front = await showRobot();
    const surface = await robotSurface();
    let tab: RobotTab | null = null;
    if (surface === 'tab') {
      const win = await browser.windows
        .getLastFocused({ windowTypes: ['normal'] })
        .catch(() => null);
      if (win?.id !== undefined && win.incognito === false) {
        const t = await browser.tabs.create({ windowId: win.id, url, active: front });
        if (t.id !== undefined) {
          tab = new RobotTab(run, t.id, win.id, false);
          await tab.group();
        }
      }
    }
    if (!tab) {
      // No normal Chrome window open (or the window surface is chosen): a separate window.
      const w = await browser.windows.create({
        url,
        focused: front,
        type: 'normal',
        width: 1200,
        height: 900,
      });
      const id = w?.tabs?.[0]?.id;
      if (id === undefined || w?.id === undefined)
        throw new Error('Could not open a LinkedIn tab.');
      tab = new RobotTab(run, id, w.id, true);
    }
    openTab = tab;
    await run.log(
      `Opened the robot ${tab.ownWindow ? 'window' : 'tab'}${front ? ' (in front)' : ''}: ${new URL(url).pathname}`,
      { step: 'open' },
    );
    return tab;
  }

  private async group() {
    try {
      const groupId = await browser.tabs.group({
        tabIds: [this.tabId],
        createProperties: { windowId: this.windowId },
      });
      await browser.tabGroups.update(groupId, { title: 'Brandovise robot', color: 'blue' });
    } catch {
      // Tab groups are a nicety; the tab works without one.
    }
  }

  // Navigates and waits until the content script answers and the page has content.
  async goto(url: string, label?: string): Promise<PageState> {
    this.run.check();
    await this.run.log(label ?? `Opening ${new URL(url).pathname}`, { step: 'page' });
    await browser.tabs.update(this.tabId, { url });
    return this.ready();
  }

  async ready(): Promise<PageState> {
    const started = Date.now();
    await sleep(1500);
    let last: PageState | null = null;
    while (Date.now() - started < 60_000) {
      this.run.check();
      const tab = await browser.tabs.get(this.tabId).catch(() => null);
      if (!tab) throw new StopRequested('Stopped: the robot tab was closed.');
      const path = new URL(tab.url || 'https://www.linkedin.com/').pathname;
      if (BLOCKED.test(path)) throw new LinkedInBlocked(`LinkedIn sent the robot tab to ${path}`);
      last = (await browser.tabs
        .sendMessage(this.tabId, { type: 'ping' })
        .catch(() => null)) as PageState | null;
      // Some content is there (LinkedIn keeps loading in the background; "complete" may never come).
      if (last?.ok && last.nodes > 40) break;
      await sleep(1000);
    }
    if (!last?.ok) throw new Error('LinkedIn did not load in time.');
    // Settle 3-6 s like a person reading the page header.
    await sleep(3000 + Math.random() * 3000);
    return last;
  }

  async send<T>(msg: Record<string, unknown>): Promise<T> {
    this.run.check();
    // Feed scrolling and posting can take minutes. Chrome stops an extension's service worker that
    // looks idle (09.10.2026: a comment round was cut off after one scroll step), so a cheap extension
    // call every 20 s keeps it alive until the page answers.
    const keepAlive = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);
    try {
      return (await browser.tabs.sendMessage(this.tabId, msg)) as T;
    } finally {
      clearInterval(keepAlive);
    }
  }

  async show() {
    await browser.tabs.update(this.tabId, { active: true }).catch(() => undefined);
    await browser.windows.update(this.windowId, { focused: true }).catch(() => undefined);
  }

  async close() {
    this.closing = true;
    browser.tabs.onRemoved.removeListener(this.onRemoved);
    if (openTab === this) openTab = null;
    if (this.closedByUser) return;
    if (this.ownWindow) await browser.windows.remove(this.windowId).catch(() => undefined);
    else await browser.tabs.remove(this.tabId).catch(() => undefined);
  }
}

export class LinkedInBlocked extends Error {}

// Runs `work` with a robot tab and always closes it. Warnings and stops come back as results.
export async function withRobotTab<T>(
  run: JobRun,
  url: string,
  work: (tab: RobotTab) => Promise<T>,
): Promise<T> {
  const tab = await RobotTab.open(run, url);
  try {
    await tab.ready();
    return await work(tab);
  } finally {
    await tab.close();
    await run.log(`Closed the robot ${tab.ownWindow ? 'window' : 'tab'}`, { step: 'close' });
  }
}
