// Dev-only diagnostic: load dev:live, click Save draft (no generation, no
// spend), and record failing backend requests so a storage 401/403 can be
// attributed to an exact procedure instead of guessed at.
import { createRequire } from 'node:module';
const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
const bad = [];
page.on('response', (res) => {
  if (res.status() >= 400) bad.push({ status: res.status(), url: res.url().slice(0, 220) });
});
page.on('requestfailed', (req) => bad.push({ status: 'REQFAIL', url: req.url().slice(0, 220), err: req.failure()?.errorText }));
await page.goto('http://localhost:5186/', { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-testid="eb-app"]', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 5000));
await page.click('[data-testid="eb-save-draft"]');
await new Promise((r) => setTimeout(r, 6000));
const notice = await page.evaluate(() => document.querySelector('[data-testid="eb-storage-notice"]')?.textContent ?? null);
const drafts = await page.evaluate(() => document.querySelector('[data-testid="eb-drafts"]')?.textContent ?? null);
console.log('storage notice:', notice);
console.log('drafts panel:', drafts?.replace(/\s+/g, ' ').slice(0, 240));
console.log('failing requests:');
for (const b of bad) console.log(' ', JSON.stringify(b));
await browser.close();
