import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));

// A fake feed with two posts, shaped like LinkedIn's (reactions menu button, permalink, author link).
// LinkedIn itself is never contacted. Any click on the page would set window.clicked.
const post = (id: string, name: string, text: string) => `
  <div><div><a href="/in/${name.toLowerCase()}/"><span>${name}</span></a><p>Inhaber Maklerbüro</p><span>2h •</span></div>
  <p><span dir="ltr">${text}</span></p>
  <div><button aria-label="Open reactions menu"></button><span>12 reactions</span><span>3 comments</span>
  <a href="/feed/update/urn:li:activity:${id}/">Comment</a></div></div>`;
const FEED = `<!doctype html><html lang="en"><body><main>
  ${post('111', 'Anna', 'Schadenmeldungen per E-Mail zuordnen kostet uns jeden Tag zwei Stunden im Innendienst.')}
  ${post('222', 'Bernd', 'Wer hat Erfahrung mit KI bei der Angebotserstellung im Maklerbüro gemacht?')}
  </main><script>window.clicked=false;document.addEventListener('click',()=>{window.clicked=true},true)</script></body></html>`;

test('the post reader reads posts from a LinkedIn page without clicking', async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  await context.route('https://www.linkedin.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: FEED }),
  );
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');

  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  const li = await context.newPage();
  await li.goto('https://www.linkedin.com/feed/');
  await li.bringToFront();

  const res = await ext.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
      const r = await chrome.tabs.sendMessage(tab!.id!, { type: 'readPosts' }).then(
        (posts) => ({ ok: posts.ok, result: posts.posts }),
        () => ({ ok: false, result: [] }),
      );
      if (r.ok) return r;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return null;
  });
  expect(res?.ok).toBe(true);
  expect(res.result).toHaveLength(2);
  expect(res.result[0]).toMatchObject({
    author: 'Anna',
    urn: 'urn:li:activity:111',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:111/',
    relativeDate: '2h',
    reactions: 12,
    comments: 3,
    media: 'none',
  });
  expect(await li.evaluate(() => (window as unknown as { clicked: boolean }).clicked)).toBe(false);
  await context.close();
});
