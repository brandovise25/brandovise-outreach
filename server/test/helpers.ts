import pg from 'pg';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { TokenService } from '../src/auth/tokens.ts';
import { hashPassword } from '../src/auth/passwords.ts';
import { OpenRouterClient, type FetchLike } from '../src/ai/openrouter.ts';

// Requires scripts/test-db.sh up. Defaults match that script.
export const OWNER_URL =
  process.env.TEST_OWNER_URL ??
  'postgres://postgres:postgres@localhost:54329/outreach_test?sslmode=disable';
export const API_URL =
  process.env.TEST_API_URL ?? 'postgres://api_rpc:api_rpc_test@localhost:54329/outreach_test';

export const EMAIL = 'test@example.com';
export const PASSWORD = 'correct horse battery staple';
export const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

export async function owner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function resetData() {
  await owner(async (c) => {
    await c.query(
      'truncate outreach.ai_calls, outreach.ext_devices, outreach.refresh_tokens, outreach.app_users cascade',
    );
    await c.query(`insert into outreach.app_users (email, password_hash) values ($1, $2)`, [
      EMAIL,
      await hashPassword(PASSWORD),
    ]);
    // companies point at campaigns and are pointed at by leads; no test may leave them behind
    await c.query(
      `update outreach.candidates set company_id = null where company_id is not null;
       update outreach.prospects set company_id = null where company_id is not null;
       delete from outreach.companies`,
    );
    await c.query(`update outreach.settings set value = '0.1.0' where key = 'ext_min_version'`);
    // the safe default; tests that need live sending switch it off themselves
    await c.query(`update outreach.settings set value = 'true' where key = 'ext_dry_run'`);
    await c.query(`select outreach.doc_put('browsing_conduct', 'test conduct', 'test')`);
    await c.query(`update outreach.settings set value = '2.00' where key = 'ai_daily_budget_usd'`);
  });
}

export async function makeApp(fetchImpl?: FetchLike, webFetch?: typeof fetch) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: API_URL,
    JWT_SECRET: 'x'.repeat(40),
    ALLOWED_ORIGINS: 'chrome-extension://abc',
    API_TOKEN: 'test-api-token-0123456789abcdef0123456789',
  });
  const db = createDb(config.DATABASE_URL);
  const app = await buildApp({
    config,
    db,
    tokens: new TokenService(config.JWT_SECRET),
    openrouter: fetchImpl
      ? new OpenRouterClient('test-key', 'https://openrouter.test/api/v1', fetchImpl)
      : undefined,
    webFetch,
  });
  return { app, db };
}
