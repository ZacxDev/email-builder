// Post-approval storage persistence proof against the REAL host (dev:live).
// No generation is triggered — this only exercises apps:storage:
// save a draft -> reload -> draft must still be there -> delete -> reload -> gone.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');
const CHROME = '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.EB_BASE ?? 'http://localhost:5186';
const OUT = '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder/storage-check.png';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const log = (...a) => console.log(...a);

const draftsText = async () =>
  page.evaluate(() => document.querySelector('[data-testid="eb-drafts"]')?.textContent ?? '(no drafts card)');
const noticeText = async () =>
  page.evaluate(() => document.querySelector('[data-testid="eb-storage-notice"]')?.textContent ?? document.querySelector('[data-testid="eb-notice"]')?.textContent ?? '(no notice)');

await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 4000));
log('initial drafts:', await draftsText());

// Save the fresh draft explicitly.
await page.evaluate(() => document.querySelector('[data-testid="eb-save-draft"]')?.click());
await new Promise((r) => setTimeout(r, 4000));
log('after save, notice:', await noticeText());
log('after save, drafts:', await draftsText());

// Reload: persistence lives or dies here.
await page.reload({ waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 5000));
const afterReload = await draftsText();
log('after reload, drafts:', afterReload);
const persisted = /Untitled email/.test(afterReload);
log(persisted ? 'PERSISTED ✓' : 'NOT PERSISTED ✗');

// Cleanup: delete the test draft (two-tap confirm).
if (persisted) {
  const clicked = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="eb-drafts"]');
    if (!card) return false;
    const btn = [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete');
    btn?.click();
    return !!btn;
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => {
    const card = document.querySelector('[data-testid="eb-drafts"]');
    const btn = [...(card?.querySelectorAll('button') ?? [])].find((b) => /Confirm delete/.test(b.textContent ?? ''));
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 3000));
  log('cleanup clicked:', clicked, '| drafts now:', await draftsText());
}

await page.screenshot({ path: OUT });
fs.writeFileSync('/tmp/eb-storage-check.json', JSON.stringify({ persisted, errors }, null, 2));
log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exitCode = persisted && errors.length === 0 ? 0 : 1;
