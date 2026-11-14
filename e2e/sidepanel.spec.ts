import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));
const env = Object.fromEntries(
  readFileSync(new URL('../.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
) as { E2E_EMAIL: string; E2E_PASSWORD: string };

// The side panel is a frame around <server>/app/; the extension passes the login to it.
test('side panel shows the web app from the server, signed in through the extension', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    viewport: { width: 400, height: 900 },
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'setServer', url: 'http://localhost:3300' }),
  );
  await options.reload();
  await options.getByLabel('Email').fill(env.E2E_EMAIL);
  await options.getByLabel('Password').fill(env.E2E_PASSWORD);
  await options.getByRole('button', { name: 'Sign in' }).click();
  await expect(options.getByLabel('Status')).toContainText('yes');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  const app = panel.frameLocator('iframe');
  await expect(app.getByRole('tab', { name: /^Today/ })).toBeVisible({ timeout: 15_000 });
  await expect(app.getByText('Waiting for you')).toBeVisible();
  await app.getByRole('button', { name: /Activity log/ }).click();
  await expect(
    app.getByText(/No activity yet|run ·|Profile checked|New prospect/).first(),
  ).toBeVisible();
  await app.getByRole('tab', { name: /^Campaigns/ }).click();
  await expect(app.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  await app.getByRole('tab', { name: /^Approve/ }).click();
  await expect(app.getByRole('button', { name: /^Withdrawals/ })).toBeVisible();
  await context.close();
});

test('the web app also works on its own in a browser tab (login form)', async ({ page }) => {
  await page.goto('http://localhost:3300/app/');
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
});
