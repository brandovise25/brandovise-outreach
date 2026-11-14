// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for the parts of chrome.* the login state uses.
const store: Record<string, unknown> = {};
const setIcon = vi.fn();
const setTitle = vi.fn();
const notify = vi.fn();
(globalThis as Record<string, unknown>).browser = {
  storage: {
    local: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => Object.assign(store, o),
    },
  },
  action: { setIcon, setTitle },
  notifications: { create: notify },
  runtime: { getURL: (p: string) => p },
};

const { linkedInLoggedIn, pageShowsLoggedOut, refreshLoginState, reportLogin } =
  await import('../src/lib/linkedin-login.ts');

beforeEach(() => {
  setIcon.mockClear();
  setTitle.mockClear();
  notify.mockClear();
});

describe('LinkedIn login state', () => {
  it('reads a logged-out page from the path or the sign-in form, never from a security check', () => {
    document.body.innerHTML = '<main>Feed</main>';
    expect(pageShowsLoggedOut('/feed/', document)).toBe(false);
    expect(pageShowsLoggedOut('/authwall', document)).toBe(true);
    expect(pageShowsLoggedOut('/login', document)).toBe(true);
    expect(pageShowsLoggedOut('/checkpoint/challenge/abc', document)).toBe(false);
    document.body.innerHTML =
      '<form action="/checkpoint/lg/login-submit"><input name="session_password"></form>';
    expect(pageShowsLoggedOut('/in/someone/', document)).toBe(true);
  });

  it('counts as logged in until a page showed otherwise', async () => {
    expect(await linkedInLoggedIn()).toBe(true);
  });

  it('greys the icon when a page shows the login, notifies once, and restores it on a normal page', async () => {
    await reportLogin(true);
    expect(setIcon.mock.calls.at(-1)![0].path[16]).toBe('/icon/16.png');
    expect(notify).not.toHaveBeenCalled();

    await reportLogin(false);
    expect(await linkedInLoggedIn()).toBe(false);
    expect(setIcon.mock.calls.at(-1)![0].path[16]).toBe('/icon-off/16.png');
    expect(setTitle.mock.calls.at(-1)![0].title).toMatch(/not logged in/);
    expect(notify).toHaveBeenCalledTimes(1);

    // same state again: no new icon, no second notification
    await reportLogin(false);
    await refreshLoginState();
    expect(setIcon).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);

    await reportLogin(true);
    expect(await linkedInLoggedIn()).toBe(true);
    expect(setIcon.mock.calls.at(-1)![0].path[16]).toBe('/icon/16.png');
  });
});
