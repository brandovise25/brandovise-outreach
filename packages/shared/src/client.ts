import {
  AiResponse,
  ExtSettings,
  HeartbeatResponse,
  Limits,
  TokenPair,
  type AiTaskName,
  type HeartbeatRequest,
} from './api.ts';
import { z } from 'zod';

// API client shared by the extension (tokens in chrome.storage.local) and the web app
// (tokens in sessionStorage). Persistent key-value store; a Map in tests.
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKENS_KEY = 'auth.tokens';
const DEVICE_KEY = 'device.id';

export class ApiClient {
  private refreshing: Promise<TokenPair | undefined> | undefined;

  constructor(
    // Resolved per request, so switching servers on the options page takes effect immediately.
    private readonly baseUrl: () => Promise<string>,
    private readonly version: string,
    private readonly store: KeyValueStore,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async deviceId(): Promise<string> {
    let id = await this.store.get<string>(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      await this.store.set(DEVICE_KEY, id);
    }
    return id;
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.store.get<TokenPair>(TOKENS_KEY)) !== undefined;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.raw('POST', '/auth/login', {
      email,
      password,
      deviceId: await this.deviceId(),
    });
    await this.store.set(TOKENS_KEY, TokenPair.parse(res));
  }

  // Drops the tokens without calling the server (used when switching servers).
  async forgetTokens(): Promise<void> {
    await this.store.remove(TOKENS_KEY);
  }

  async logout(): Promise<void> {
    const tokens = await this.store.get<TokenPair>(TOKENS_KEY);
    await this.store.remove(TOKENS_KEY);
    if (tokens) {
      await this.raw('POST', '/auth/logout', { refreshToken: tokens.refreshToken }).catch(
        () => undefined,
      );
    }
  }

  heartbeat(body: Omit<HeartbeatRequest, 'deviceId'>) {
    return this.deviceId().then((deviceId) =>
      this.authed('POST', '/ext/heartbeat', HeartbeatResponse, { ...body, deviceId }),
    );
  }
  settings() {
    return this.authed('GET', '/ext/settings', ExtSettings);
  }
  limits() {
    return this.authed('GET', '/ext/limits', Limits);
  }
  // Returns a valid access token, refreshing it first when it is about to expire.
  async accessToken(): Promise<string> {
    let tokens = await this.store.get<TokenPair>(TOKENS_KEY);
    if (!tokens) throw new ApiRequestError(401, 'unauthorized', 'not signed in');
    if (Date.parse(tokens.accessExpiresAt) - Date.now() < 30_000) tokens = await this.refresh();
    if (!tokens) throw new ApiRequestError(401, 'unauthorized', 'not signed in');
    return tokens.accessToken;
  }

  // Side-panel / web-app data.
  panel(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return this.authed(method, path, z.unknown(), body);
  }
  ai(task: AiTaskName, input: Record<string, unknown>) {
    return this.authed('POST', `/ai/${task}`, AiResponse, { input });
  }

  private async authed<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    let tokens = await this.store.get<TokenPair>(TOKENS_KEY);
    if (!tokens) throw new ApiRequestError(401, 'unauthorized', 'not signed in');
    if (Date.parse(tokens.accessExpiresAt) - Date.now() < 30_000) tokens = await this.refresh();
    try {
      return schema.parse(await this.raw(method, path, body, tokens?.accessToken));
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 401) throw err;
      tokens = await this.refresh();
      return schema.parse(await this.raw(method, path, body, tokens?.accessToken));
    }
  }

  // Single-flight refresh so parallel calls do not rotate the same token twice (which revokes everything).
  private refresh(): Promise<TokenPair | undefined> {
    this.refreshing ??= (async () => {
      try {
        const current = await this.store.get<TokenPair>(TOKENS_KEY);
        if (!current) throw new ApiRequestError(401, 'unauthorized', 'not signed in');
        try {
          const next = TokenPair.parse(
            await this.raw('POST', '/auth/refresh', { refreshToken: current.refreshToken }),
          );
          await this.store.set(TOKENS_KEY, next);
          return next;
        } catch (err) {
          if (err instanceof ApiRequestError && err.status === 401)
            await this.store.remove(TOKENS_KEY);
          throw err;
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { 'x-extension-version': this.version };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const base = await this.baseUrl();
    if (!base) throw new ApiRequestError(0, 'no_server', 'no server selected');
    const res = await this.fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok)
      throw new ApiRequestError(
        res.status,
        json.code ?? 'unknown',
        json.error ?? `HTTP ${res.status}`,
      );
    return json;
  }
}
