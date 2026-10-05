// Supplemental UX review captures: Open-draft + preview Mobile toggle.
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
async function newPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluateOnNewDocument((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    if (document.head) document.head.appendChild(style);
    else document.addEventListener('DOMContentLoaded', () => document.head?.appendChild(style), { once: true });
  }, HIDE_DEV_CHROME);
  return page;
}

// Open the seeded draft from the library (demo page) and see identity/state swap.
{
  const page = await newPage({ width: 390, height: 1300 });
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  // First, start a New email so "Open" changes something observable.
  await page.click('[data-testid="eb-new"]');
  await settle(600);
  const beforeOpen = await page
    .$eval('[data-testid="eb-current-draft"]', (el) => el.innerText.trim())
    .catch(() => null);
  // Click the (single) "Open" button in the drafts card.
  const opened = await page
    .evaluate(() => {
      const card = document.querySelector('[data-testid="eb-drafts"]');
      const btn = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Open');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  await settle(900);
  const afterOpen = await page
    .$eval('[data-testid="eb-current-draft"]', (el) => el.innerText.trim())
    .catch(() => null);
  const brief = await page
    .$eval('[data-testid="eb-brief"]', (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140))
    .catch(() => null);
  console.log('[note] open-draft: clicked=%s editing %s -> %s brief=%s', opened, beforeOpen, afterOpen, brief);
  await page.screenshot({ path: path.join(OUT, '32-opened-draft-mobile.png') });
  console.log('captured 32-opened-draft-mobile.png');
  await page.close();
}

// Preview Mobile width toggle.
{
  const page = await newPage({ width: 390, height: 1300 });
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  const clicked = await page
    .evaluate(() => {
      const card = document.querySelector('[data-testid="eb-preview"]');
      const btn = [...(card?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === 'Mobile');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  await settle(700);
  const preview = await page
    .$eval('[data-testid="eb-preview"]', (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160))
    .catch(() => null);
  console.log('[note] preview-mobile-toggle clicked=%s preview=%s', clicked, preview);
  await page.screenshot({ path: path.join(OUT, '33-preview-mobile-toggle.png') });
  console.log('captured 33-preview-mobile-toggle.png');
  await page.close();
}

await browser.close();
console.log('done');
