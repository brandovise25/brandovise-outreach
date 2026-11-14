import { chromeStore } from './chrome-store.ts';

// LinkedIn login state (Jibran, 05.11.2026): when LinkedIn is logged out, the extension icon turns grey
// and the robot takes no jobs (they stay queued). Judged from what LinkedIn pages show, not from a
// cookie: on 05.11.2026 the session cookie li_at was not visible to the extension although Jibran was
// logged in. Logged out only when a page showed the sign-in page or login wall; any normal LinkedIn
// page counts as logged in again. The robot never logs in itself.

const KEY = 'linkedin.login';
// Sign-in and login-wall pages. /checkpoint/challenge is a security check (handled as a warning
// elsewhere), not a logout.
const LOGGED_OUT_PATHS = /^\/(authwall|login|uas\/login|signup|checkpoint\/lg)\b/;

export function pageShowsLoggedOut(pathname: string, doc: Document): boolean {
  if (LOGGED_OUT_PATHS.test(pathname)) return true;
  return !!doc.querySelector('form[action*="login-submit"], input[name="session_password"]');
}

export async function linkedInLoggedIn(): Promise<boolean> {
  try {
    const s = await chromeStore.get<{ loggedIn: boolean }>(KEY);
    return s?.loggedIn !== false;
  } catch {
    return true; // no storage (tests): do not block the robot
  }
}

// From the content script: what the page that just loaded shows.
export async function reportLogin(loggedIn: boolean): Promise<void> {
  await chromeStore.set(KEY, { loggedIn, at: new Date().toISOString() });
  await refreshLoginState();
}

let shown: boolean | null = null;

// Sets the icon to match; returns the state. Notifies once when the login is lost.
export async function refreshLoginState(): Promise<boolean> {
  const on = await linkedInLoggedIn();
  if (on === shown) return on;
  const lost = shown === true && !on;
  shown = on;
  try {
    await browser.action.setIcon({
      path: Object.fromEntries(
        [16, 32, 48, 128].map((s) => [s, `/${on ? 'icon' : 'icon-off'}/${s}.png`]),
      ),
    });
    await browser.action.setTitle({
      title: on
        ? 'Brandovise Outreach'
        : 'Brandovise Outreach: LinkedIn is not logged in. The robot waits until you log in.',
    });
    if (lost)
      await browser.notifications.create(`login-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon-off/128.png'),
        title: 'LinkedIn is logged out',
        message: 'The robot pauses until you log in to LinkedIn in Chrome.',
      });
  } catch {
    // not available in tests
  }
  return on;
}
