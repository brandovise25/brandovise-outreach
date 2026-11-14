import { describe, expect, it, vi } from 'vitest';
import { ApiClient, type KeyValueStore } from '../src/client.ts';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => data.get(k) as T | undefined,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pair = (n: number, accessTtlMs = 15 * 60_000) => ({
  accessToken: `access-${n}`,
  accessExpiresAt: new Date(Date.now() + accessTtlMs).toISOString(),
  refreshToken: `refresh-${n}-xxxxxxxxxxxxxxxxxxxx`,
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const limits = {
  invite_status: 'open',
  invites_allowed_now: 1,
  messages_allowed_now: 2,
  invites_resume_at: null,
};

describe('ApiClient', () => {
  it('logs in and keeps a stable device id', async () => {
    const store = memoryStore();
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json(pair(1)));
    const api = new ApiClient(async () => 'https://api.test', '0.1.0', store, fetchMock);
    await api.login('a@b.de', 'pw');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.deviceId).toBe(await api.deviceId());
    expect(await api.isSignedIn()).toBe(true);
  });

  it('refreshes once when the access token is about to expire, even for parallel calls', async () => {
    const store = memoryStore();
    store.data.set('auth.tokens', pair(1, 1000));
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return path === '/auth/refresh' ? json(pair(2)) : json(limits);
    });
    const api = new ApiClient(async () => 'https://api.test', '0.1.0', store, fetchMock);
    await Promise.all([api.limits(), api.limits()]);
    expect(calls.filter((c) => c === '/auth/refresh')).toHaveLength(1);
    expect((store.data.get('auth.tokens') as { accessToken: string }).accessToken).toBe('access-2');
  });

  it('signs out locally when the refresh token is rejected', async () => {
    const store = memoryStore();
    store.data.set('auth.tokens', pair(1, 1000));
    const fetchMock = vi.fn(async () =>
      json({ error: 'refresh rejected', code: 'unauthorized' }, 401),
    );
    const api = new ApiClient(async () => 'https://api.test', '0.1.0', store, fetchMock);
    await expect(api.limits()).rejects.toThrow('refresh rejected');
    expect(await api.isSignedIn()).toBe(false);
  });

  it('sends the extension version on every request', async () => {
    const store = memoryStore();
    store.data.set('auth.tokens', pair(1));
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json(limits));
    const api = new ApiClient(async () => 'https://api.test', '0.3.1', store, fetchMock);
    await api.limits();
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-extension-version']).toBe('0.3.1');
    expect(headers.authorization).toBe('Bearer access-1');
  });
});
