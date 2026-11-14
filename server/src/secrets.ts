import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AppDeps } from './app.ts';
import { callJson } from './db.ts';

// Keys Jibran enters in Settings (13.11.2026), e.g. the web-search key. They are encrypted here
// (AES-256-GCM, key derived from JWT_SECRET) before they reach the database, so a database copy or
// backup alone does not reveal them. The app can set or clear a key and see a hint, never the value.

export const SECRET_NAMES = ['serper_api_key'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const keyOf = (deps: AppDeps) =>
  createHash('sha256').update(`secrets:${deps.config.JWT_SECRET}`).digest();

export function seal(deps: AppDeps, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(deps), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64'),
    c.getAuthTag().toString('base64'),
    body.toString('base64'),
  ].join(':');
}
export function open(deps: AppDeps, sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', keyOf(deps), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // wrong key (JWT_SECRET changed) or damaged value
  }
}

export async function setSecret(deps: AppDeps, userId: string, name: SecretName, value: string) {
  const v = value.trim();
  return callJson(deps.db, 'ext_secret_set', [
    userId,
    name,
    v ? seal(deps, v) : '',
    v ? `…${v.slice(-4)}` : null,
  ]);
}
export async function getSecret(
  deps: AppDeps,
  userId: string,
  name: SecretName,
): Promise<string | null> {
  const row = await callJson<{ value: string } | null>(deps.db, 'ext_secret_get', [userId, name]);
  return row?.value ? open(deps, row.value) : null;
}
