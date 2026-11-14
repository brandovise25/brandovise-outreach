// The server the extension talks to is chosen at runtime on the options page, so one zip works
// for both the local Docker stack and the Easypanel server.
export const LOCAL_SERVER_URL = 'http://localhost:3300';
// Optional build-time default for the "Server" choice (WXT_SERVER_URL=https://outreach.example.com).
export const DEFAULT_SERVER_URL: string = import.meta.env.WXT_SERVER_URL ?? '';

export const SERVER_URL_KEY = 'server.url';

// Accepts https anywhere, and plain http only for localhost.
export function normalizeServerUrl(input: string): string {
  const url = new URL(input.trim());
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Server URL must use https (http is only allowed for localhost)');
  }
  return url.origin;
}

// Match pattern for chrome.permissions; ports are ignored by match patterns.
export function originPattern(serverUrl: string): string {
  const url = new URL(serverUrl);
  return `${url.protocol}//${url.hostname}/*`;
}
