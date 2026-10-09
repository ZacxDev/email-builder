// Supplemental 2: bundle price-confirm (from demo state) + cancel path.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME =
  '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.EB_SHOT_BASE ?? 'http://localhost:5186';
const OUT = path.resolve(
  process.env.EB_SHOT_OUT ??
    '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder/ux-review-2026-10-05',
);
fs.mkdirSync(OUT, { recursive: true });
const HIDE_DEV_CHROME = `
  [data-harness-banner], [data-harness-scenario-panel],
  [data-harness="true"] > details { display: none !important; }
  html, body { background: #101113; }
`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 1300 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.evaluateOnNewDocument((css) => {
  const style = document.createElement('style');
  style.textContent = css;
  if (document.head) document.head.appendChild(style);
  else document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(style), { once: true });
}, HIDE_DEV_CHROME);
await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
await settle(1300);

await page.click('[data-testid="eb-generate-bundle"]');
await settle(1600);
const confirmText = await page
  .$eval('[data-testid="eb-confirm"]', (el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
  .catch(() => null);
const inView = await page
  .evaluate(() => {
    const el = document.querySelector('[data-testid="eb-confirm"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  })
  .catch(() => false);
console.log('[note] bundle confirm:', JSON.stringify(confirmText), 'inViewport(top):', inView);
await page.screenshot({ path: path.join(OUT, '34-bundle-confirm-mobile.png') });
console.log('captured 34-bundle-confirm-mobile.png');

await page.click('[data-testid="eb-confirm-cancel"]');
await settle(700);
const afterCancelFlash = await page
  .$eval('[data-testid="eb-flash"]', (el) => el.innerText.trim())
  .catch(() => null);
const afterCancelNotice = await page
  .$eval('[data-testid="eb-notice"]', (el) => el.innerText.trim())
  .catch(() => null);
console.log('[note] after bundle-cancel: flash=%s notice=%s', afterCancelFlash, afterCancelNotice);
await page.screenshot({ path: path.join(OUT, '35-bundle-confirm-cancelled-mobile.png') });
console.log('captured 35-bundle-confirm-cancelled-mobile.png');
await browser.close();
console.log('done');
