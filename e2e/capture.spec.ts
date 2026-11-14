import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));

// LinkedIn is never contacted: every www.linkedin.com request is answered by this fake page.
const FAKE_PROFILE = `<!doctype html><html lang="en"><head><script>window.secret="Anna Wagner"</script></head>
<body><main><section><h1>Anna Wagner</h1><div>Versicherungsmaklerin | Inhaberin</div>
<button aria-label="Invite Anna Wagner to connect"><span>Connect</span></button></section></main></body></html>`;

test('captures a redacted copy of a LinkedIn page through the content script', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PROFILE }),
  );
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');

  const li = await context.newPage();
  await li.goto('https://www.linkedin.com/in/anna-wagner/');
  await li.waitForLoadState('load');

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  const res = await ext.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    for (let i = 0; i < 20; i++) {
      try {
        return await chrome.tabs.sendMessage(tab!.id!, { type: 'capture' });
      } catch {
        await new Promise((r) => setTimeout(r, 250)); // content script still loading
      }
    }
    return null;
  });

  expect(res).toMatchObject({ ok: true, kind: 'profile', lang: 'en' });
  expect(res.html).not.toMatch(/Anna|Wagner|Versicherungsmaklerin|<script/);
  expect(res.html).toContain('<span>Connect</span>');
  expect(res.html).toContain('Invite xxxx xxxxxx to connect');
  await context.close();
});
