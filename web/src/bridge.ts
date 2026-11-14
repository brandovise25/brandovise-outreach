// Talks to the extension when the app runs inside its side panel (an iframe). The extension holds the
// login and the LinkedIn-only abilities; the app asks for them by postMessage. Messages are only
// accepted from the extension's own origin, which the extension announces in the iframe URL.

const params = new URLSearchParams(location.search);
const parentOrigin = params.get('ext');
export const embedded =
  !!parentOrigin &&
  /^chrome-extension:\/\/[a-p]{32}$/.test(parentOrigin) &&
  window.parent !== window;

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener('message', (e) => {
  if (!embedded || e.origin !== parentOrigin || e.source !== window.parent) return;
  const m = e.data as { id?: number; ok?: boolean; result?: unknown; error?: string };
  const p = typeof m?.id === 'number' ? pending.get(m.id) : undefined;
  if (!p) return;
  pending.delete(m.id!);
  if (m.ok) p.resolve(m.result);
  else p.reject(new Error(m.error ?? 'extension error'));
});

export function askExtension<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!embedded) return Promise.reject(new Error('only available inside the extension side panel'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.parent.postMessage({ id, type, ...payload }, parentOrigin!);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('the extension did not answer'));
    }, 60_000);
  });
}
