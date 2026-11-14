import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));

// A fake feed where only 4 posts are in the page at first; more appear as the page is scrolled, like
// LinkedIn's infinite feed. LinkedIn itself is never contacted.
const FEED = `<!doctype html><html lang="en"><body><main id="feed"></main><script>
  let n = 0;
  const add = (k) => { for (let i = 0; i < k; i++) { n++;
    document.getElementById('feed').insertAdjacentHTML('beforeend',
      '<div style="min-height:500px"><div><a href="/in/autor-' + n + '/"><span>Autor ' + n + '</span></a><p>Inhaber</p><span>' + n + 'h •</span></div>' +
      '<p><span dir="ltr">Beitrag ' + n + ' über Prozesse im Maklerbüro und die tägliche Arbeit im Innendienst.</span></p>' +
      '<div><button aria-label="Open reactions menu"></button><a href="/feed/update/urn:li:activity:' + (9000 + n) + '/">Comment</a></div></div>'); } };
  add(4);
  addEventListener('scroll', () => { if (scrollY + innerHeight > document.body.scrollHeight - 600 && n < 16) add(3); });
</script></body></html>`;

test('scrolls the feed at reading pace and collects posts that load on the way', async () => {
  test.setTimeout(240_000);
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  await context.route('https://www.linkedin.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: FEED }),
  );
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const li = await context.newPage();
  await li.goto('https://www.linkedin.com/feed/');
  await li.waitForTimeout(1500);

  const started = Date.now();
  const res = await ext.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    return chrome.tabs.sendMessage(tab!.id!, { type: 'scrollFeed', ownWindow: true });
  });
  const seconds = (Date.now() - started) / 1000;

  expect(res.ok).toBe(true);
  expect(res.posts.length).toBeGreaterThanOrEqual(15); // only 4 were there at the start
  expect(['target', 'end']).toContain(res.stoppedBy);
  // Reading pace: several steps with 2-5 s between them, not one jump.
  expect(res.steps).toBeGreaterThanOrEqual(3);
  expect(seconds).toBeGreaterThan(res.steps * 2);
  await context.close();
});
