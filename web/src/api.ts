import { ApiClient, ApiRequestError, type KeyValueStore } from '@outreach/shared';
import { askExtension, embedded } from './bridge.ts';

// Standalone (browser tab): own login, tokens in sessionStorage (cleared when the tab closes).
// Embedded (extension side panel): the extension owns the login and hands out access tokens.
const sessionStore: KeyValueStore = {
  async get<T>(k: string) {
    const v = sessionStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : undefined;
  },
  async set(k, v) {
    sessionStorage.setItem(k, JSON.stringify(v));
  },
  async remove(k) {
    sessionStorage.removeItem(k);
  },
};

export const APP_VERSION = '0.1.0';
const client = new ApiClient(async () => location.origin, APP_VERSION, sessionStore);

async function token(): Promise<string> {
  if (embedded) return askExtension<string>('token');
  return client.accessToken();
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 401 && attempt === 0) continue; // token just expired: ask again once
    if (!res.ok)
      throw new ApiRequestError(
        res.status,
        json.code ?? 'unknown',
        json.error ?? `HTTP ${res.status}`,
      );
    return json as T;
  }
  throw new ApiRequestError(401, 'unauthorized', 'not signed in');
}

export const panelGet = <T>(path: string) => call<T>('GET', path);
export const panelPost = <T>(path: string, body: unknown) => call<T>('POST', path, body);

// null = signed in; otherwise the reason, shown to the user so problems are visible.
export async function signInProblem(): Promise<string | null> {
  if (embedded) {
    return askExtension<string>('token').then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  }
  return (await client.isSignedIn()) ? null : 'not signed in';
}
export const login = (email: string, password: string) => client.login(email, password);
export const logout = () => client.logout();

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Inside the side panel the extension opens the tab (keeps the panel open); standalone a new tab.
export function openTab(url: string | null | undefined) {
  if (!url) return;
  if (embedded)
    void askExtension('openTab', { url }).catch(() => window.open(url, '_blank', 'noopener'));
  else window.open(url, '_blank', 'noopener');
}
