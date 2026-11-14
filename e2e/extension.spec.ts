import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import pg from 'pg';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));
const LOCAL = 'http://localhost:3300';
const OWNER_URL =
  'postgres://outreach_owner:local_owner_pw@localhost:54330/outreach?sslmode=disable';

// Test credentials for the local stack only, created by scripts/local-user.sh into .env.e2e (gitignored).
const env = Object.fromEntries(
  readFileSync(new URL('../.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
) as { E2E_EMAIL: string; E2E_PASSWORD: string };

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
});

test.afterAll(async () => {
  await context.close();
});

test('signs in to the local server and sends a heartbeat', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await expect(page.getByRole('heading', { name: 'Brandovise Outreach' })).toBeVisible();

  // The "Use this server" button asks Chrome for host permission (a browser prompt Playwright cannot
  // click). Here the server is set directly; the API call then relies on the server's CORS allowlist.
  const res = await page.evaluate(
    (url) => chrome.runtime.sendMessage({ type: 'setServer', url }),
    LOCAL,
  );
  expect(res.ok).toBe(true);
  await page.reload();

  await page.getByLabel('Email').fill(env.E2E_EMAIL);
  await page.getByLabel('Password').fill(env.E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const status = page.getByLabel('Status');
  await expect(status).toContainText('Signed in');
  await expect(status).toContainText('yes');
  await expect(status).toContainText('on (nothing is sent)');

  // Each run uses a fresh browser profile, so look up this run's device id.
  const deviceId = await page.evaluate(
    async () => (await chrome.storage.local.get('device.id'))['device.id'],
  );
  const db = new pg.Client({ connectionString: OWNER_URL });
  await db.connect();
  const { rows } = await db.query(
    `select d.version from outreach.ext_devices d join outreach.app_users u on u.id = d.user_id
     where u.email = $1 and d.device_id = $2 and d.last_seen > now() - interval '1 minute'`,
    [env.E2E_EMAIL, deviceId],
  );
  await db.end();
  expect(rows).toEqual([{ version: '0.1.0' }]);

  // Switching servers must drop the session.
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'setServer', url: 'https://outreach.example.com' }),
  );
  await page.reload();
  await expect(page.getByLabel('Status')).toContainText('no');
});
