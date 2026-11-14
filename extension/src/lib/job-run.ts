import type { ApiClient } from '@outreach/shared';

// One running job: writes every step to the server log (shown live in the app's robot bar and in
// scripts/outreach.sh log), keeps the progress counters, and learns about a Stop click with its next
// log call. Logging problems never break the job itself.

export class StopRequested extends Error {
  constructor(reason = 'Stopped.') {
    super(reason);
  }
}

export type Level = 'info' | 'warn' | 'error';
export interface Progress {
  [k: string]: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let current: JobRun | null = null;
export const currentRun = () => current;

export class JobRun {
  stopped = false;
  stopReason = 'Stopped.';
  lastMessage = '';
  private progress: Progress = {};

  constructor(
    private api: ApiClient,
    readonly id: number,
    readonly kind: string,
  ) {}

  private keepAlive: ReturnType<typeof setInterval> | null = null;

  begin(): this {
    current = this; // eslint-disable-line @typescript-eslint/no-this-alias -- the one running job
    // Chrome stops an extension service worker after ~30 s without extension events or API calls
    // (fetches to our server do not count). A job takes minutes, with many short pauses, so one cheap
    // API call every 20 s keeps the worker alive for the whole job (10.10.2026: two jobs were cut off).
    this.keepAlive = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => undefined);
    }, 20_000);
    void setBadge('●', '#0a66c2', `Robot: ${this.kind.replace(/_/g, ' ')}`);
    return this;
  }

  end(warned = false) {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (current === this) current = null;
    void setBadge(warned ? '!' : '', warned ? '#c0392b' : '#0a66c2', 'Brandovise Outreach');
  }

  stop(reason = 'Stopped.') {
    this.stopped = true;
    this.stopReason = reason;
  }

  async log(
    message: string,
    opts: {
      level?: Level;
      step?: string;
      data?: Record<string, unknown>;
      progress?: Progress;
    } = {},
  ): Promise<void> {
    this.lastMessage = message;
    if (opts.progress) this.progress = { ...this.progress, ...opts.progress };
    void setBadge('●', '#0a66c2', `Robot: ${message}`.slice(0, 120));
    try {
      const r = (await this.api.panel('POST', `/ext/jobs/${this.id}/log`, {
        level: opts.level ?? 'info',
        step: opts.step ?? null,
        message: message.slice(0, 1000),
        data: opts.data ?? null,
        progress: opts.progress ?? null,
      })) as { ok: boolean; stop: boolean };
      if (r.stop && !this.stopped) this.stop('Stopped from the app.');
    } catch {
      // The log is a view; the job goes on without it.
    }
  }

  // Throws when a stop was requested (app button, robot tab closed, warning).
  check() {
    if (this.stopped) throw new StopRequested(this.stopReason);
  }

  // A visible pause: "Waiting 74 s (between profiles)", with a countdown in the robot bar.
  async wait(minMs: number, maxMs: number, why: string): Promise<void> {
    const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
    if (ms >= 5000) {
      await this.log(`Waiting ${Math.round(ms / 1000)} s (${why})`, {
        step: 'wait',
        progress: { waitUntil: new Date(Date.now() + ms).toISOString() },
      });
    }
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.check();
      await sleep(Math.min(1000, end - Date.now()));
    }
    if (ms >= 5000) this.progress = { ...this.progress, waitUntil: null };
    this.check();
  }

  get counters(): Progress {
    return this.progress;
  }
}

async function setBadge(text: string, color: string, title: string) {
  try {
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color });
    await browser.action.setTitle({ title });
  } catch {
    // not available in tests
  }
}
