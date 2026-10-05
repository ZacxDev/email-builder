// Palette proposal screenshots (dev-only): populated demo view per palette.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.EB_SHOT_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder/palettes';
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

async function shot(name, url, viewport = { width: 1440, height: 2100 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
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
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 1300));
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('captured', name);
  await page.close();
}

for (const id of ['coral-post', 'letterpress', 'newsroom', 'violet-circuit']) {
  await shot(`palette-${id}.png`, `${BASE}/?seed=demo&palette=${id}`);
}
await shot('palette-coral-post-mobile.png', `${BASE}/?seed=demo&palette=coral-post`, { width: 390, height: 2100 });
await browser.close();
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else console.log('no page errors');
