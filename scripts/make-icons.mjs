// Renders the extension icon (blue rounded square, white "B") to PNG at the sizes Chrome uses.
// Usage: node scripts/make-icons.mjs
import { chromium } from '@playwright/test';

const svg = (
  s,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#0a66c2"/>
  <text x="64" y="92" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif"
        font-size="84" font-weight="700" fill="#fff">B</text></svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`,
  );
  await page.screenshot({ path: `extension/public/icon/${size}.png`, omitBackground: true });
}
await browser.close();
process.stdout.write('icons written\n');
