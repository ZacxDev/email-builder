// Email Builder P1 review screenshots (dev-only).
//
// Boots against the mock-host harness (seeded demo draft in storage +
// ?seed=demo finished email), hides dev chrome, captures the builder views:
// empty state, finished email (desktop), finished email (mobile, mobile
// preview width), and a tablet spot check.
//
//   npm run dev:harness   (another terminal, port 5186)
//   node tools/capture-p1.mjs

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
    '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder',
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

const problems = [];

async function newShotPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  // Headless reports light OS preference; the app must still boot dark
  // (house rule) — emulate dark to match the civitai.com default surface.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluateOnNewDocument((css) => {
    const inject = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head?.appendChild(style);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, HIDE_DEV_CHROME);
  page.on('pageerror', (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 200)}`);
  });
  return page;
}

const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));

async function shot(name, viewport, url, setup) {
  const page = await newShotPage(viewport);
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle();
  if (setup) await setup(page);
  await settle(400);
  // NOT fullPage: in headless shell, fullPage capture resizes the viewport
  // and the app's measured breakpoint tier flips mid-capture (verified: DOM
  // probes showed two-column while fullPage shots rendered single-column).
  // Tall viewports capture the whole page honestly instead.
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('captured', name);
  await page.close();
}

await shot('builder-empty-desktop.png', { width: 1440, height: 1500 }, `${BASE}/`);
await shot('builder-demo-desktop.png', { width: 1440, height: 2100 }, `${BASE}/?seed=demo`);
await shot('builder-demo-mobile.png', { width: 390, height: 2100 }, `${BASE}/?seed=demo`, async (page) => {
  // Switch the preview itself to mobile width for the narrow shot.
  const els = await page.$$('button');
  for (const el of els) {
    const text = await el.evaluate((n) => n.textContent);
    if (text?.trim() === 'Mobile') {
      await el.click();
      break;
    }
  }
});
await shot('builder-demo-tablet.png', { width: 820, height: 2400 }, `${BASE}/?seed=demo`);

await browser.close();

if (problems.length > 0) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else {
  console.log('no page errors');
}
