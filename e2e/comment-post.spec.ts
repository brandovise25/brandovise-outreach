import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';

const EXTENSION_ID = readFileSync(
  new URL('../extension/extension-id.txt', import.meta.url),
  'utf8',
).trim();
const EXT_PATH = fileURLToPath(new URL('../extension/.output/chrome-mv3', import.meta.url));

// A fake post shaped like LinkedIn's: "Comment" opens a contenteditable editor; the submit button only
// exists while there is text (like LinkedIn); pressing it appends the comment under the post.
// window.submitted counts presses. LinkedIn itself is never contacted.
const PAGE = `<!doctype html><html lang="en"><body><main>
<div id="card"><div><a href="/in/anna/"><span>Anna</span></a><p>Inhaberin</p><span>2h •</span></div>
  <p><span dir="ltr">Wir haben 30 % mehr Schadenmeldungen und zwei Kolleginnen, die alles von Hand zuordnen.</span></p>
  <div><button aria-label="Open reactions menu"></button><button id="open">Comment</button></div>
  <div id="box"></div><div id="comments"></div></div>
</main><script>
  window.submitted = 0;
  document.getElementById('open').onclick = () => {
    const box = document.getElementById('box');
    box.innerHTML = '<div contenteditable="true" role="textbox" aria-label="Text editor for creating comment"><p><br></p></div><span id="tools"></span>';
    const ed = box.querySelector('[contenteditable]');
    ed.addEventListener('input', () => {
      const has = ed.textContent.trim().length > 0, tools = document.getElementById('tools');
      if (has && !tools.firstChild) {
        const b = document.createElement('button'); b.textContent = 'Comment';
        b.onclick = () => { window.submitted++; const p = document.createElement('p');
          p.textContent = ed.innerText; document.getElementById('comments').append(p); ed.innerHTML = '<p><br></p>'; };
        tools.append(b);
      }
    });
  };
</script></body></html>`;

const TEXT =
  'Bei 30 % mehr Meldungen ist das Zuordnen der eigentliche Engpass, nicht die Meldung selbst.\n\nWie verteilen die beiden Kolleginnen die Fälle heute, nach Sparte oder nach Eingang?';

async function setup(): Promise<{
  context: BrowserContext;
  run: (dryRun: boolean) => Promise<Record<string, unknown>>;
  submitted: () => Promise<number>;
}> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  await context.route('https://www.linkedin.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }),
  );
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const li = await context.newPage();
  await li.goto('https://www.linkedin.com/feed/update/urn:li:activity:1/');
  await li.waitForTimeout(1000);
  return {
    context,
    run: (dryRun) =>
      ext.evaluate(
        async ({ text, dryRun }) => {
          const [tab] = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
          return chrome.tabs.sendMessage(tab!.id!, {
            type: 'commentOnPost',
            text,
            excerpt: 'Wir haben 30 % mehr Schadenmeldungen und zwei Kolleginnen',
            dryRun,
          });
        },
        { text: TEXT, dryRun },
      ),
    submitted: () => li.evaluate(() => (window as unknown as { submitted: number }).submitted),
  };
}

test('practice mode types the comment and finds the button, but never presses it', async () => {
  test.setTimeout(90_000);
  const { context, run, submitted } = await setup();
  const r = await run(true);
  expect(r).toMatchObject({
    dryRun: true,
    found: true,
    typed: true,
    button: 'Comment',
    clicked: false,
    verified: false,
  });
  expect(await submitted()).toBe(0);
  await context.close();
});

test('live mode posts once and verifies the comment appeared', async () => {
  test.setTimeout(90_000);
  const { context, run, submitted } = await setup();
  const r = await run(false);
  expect(r).toMatchObject({
    dryRun: false,
    found: true,
    typed: true,
    clicked: true,
    verified: true,
  });
  expect(await submitted()).toBe(1);
  // A second attempt sees the comment already there and does not post again.
  const again = await run(false);
  expect(again).toMatchObject({ verified: true, clicked: false });
  expect(again.note).toMatch(/already under the post/);
  expect(await submitted()).toBe(1);
  await context.close();
});
