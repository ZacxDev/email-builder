// v0.1.6 supplemental: duplicate, "editing" marker, rename focus-select.
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
    '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder/ux-review-v016-2026-10-05',
);
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
const notes = [];
function log(n) { notes.push(n); console.log('[note]', n); }

async function newPage(vp) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluateOnNewDocument((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    if (document.head) document.head.appendChild(style);
    else document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(style), { once: true });
  }, HIDE_DEV_CHROME);
  return page;
}
const MOBILE = { width: 390, height: 1300 };
const textOf = (page, tid) =>
  page.$eval(`[data-testid="${tid}"]`, (el) => (el.innerText || '').replace(/\s+/g, ' ').trim()).catch(() => null);

// Duplicate (single menu open — menu is a toggle).
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  await page.click('[data-testid="eb-draft-menu-demo-1"]');
  await settle(400);
  await page.click('[data-testid="eb-duplicate-demo-1"]');
  await settle(900);
  log(`23 after duplicate: ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);
  await settle(300);
  await page.screenshot({ path: path.join(OUT, '23-duplicate-mobile.png') });
  console.log('captured 23-duplicate-mobile.png');
  await page.close();
}

// Editing marker: save the current draft, library row should wear "editing".
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  await page.click('[data-testid="eb-save-draft"]');
  await settle(1200);
  const card = await textOf(page, 'eb-drafts');
  log(`24 after save (current draft is library row?): ${JSON.stringify(card)}`);
  await page.screenshot({ path: path.join(OUT, '24-editing-marker-mobile.png') });
  console.log('captured 24-editing-marker-mobile.png');
  await page.close();
}

// Rename: click INTO the input (real focus) — does the name select-all?
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  await page.click('[data-testid="eb-draft-menu-demo-1"]');
  await settle(400);
  await page.click('[data-testid="eb-rename-demo-1"]');
  await settle(500);
  await page.click('[data-testid="eb-rename-input"]');
  await settle(300);
  const sel = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="eb-rename-input"]');
    return el ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, len: el.value.length } : null;
  });
  log(`25 rename after clicking into input: ${JSON.stringify(sel)}`);
  await page.screenshot({ path: path.join(OUT, '25-rename-focus-mobile.png') });
  console.log('captured 25-rename-focus-mobile.png');
  await page.close();
}

fs.writeFileSync(path.join(OUT, '_notes-supplement.json'), JSON.stringify(notes, null, 2));
await browser.close();
console.log('done');
