// Email Builder UX review capture runner (dev-only, mock harness, no real Buzz).
// Drives the REAL UI (clicks/types/selectors) and screenshots numbered states.
//
//   npm run dev:harness   (another terminal, port 5186)
//   node tools/ux-review-captures.mjs

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

const problems = [];
const notes = [];

function log(note) {
  notes.push(note);
  console.log('[note]', note);
}

async function newPage(viewport) {
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
  page.on('pageerror', (e) => problems.push(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 300)}`);
  });
  return page;
}

const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

async function snap(page, name) {
  await settle(500);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('captured', name);
}

async function visible(page, testid) {
  return page
    .$eval(`[data-testid="${testid}"]`, (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    })
    .catch(() => false);
}

async function textOf(page, testid) {
  return page
    .$eval(`[data-testid="${testid}"]`, (el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .catch(() => null);
}

// Dump a compact inventory of what's on the page: headings, buttons, cards.
async function inventory(page, label) {
  const inv = await page
    .evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-testid="eb-app"] *').forEach((el) => {
        const tid = el.getAttribute('data-testid');
        if (['BUTTON', 'STRONG', 'H1', 'H2', 'H3'].includes(el.tagName) || tid) {
          const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          if (t) out.push(`${el.tagName.toLowerCase()}${tid ? `#${tid}` : ''} :: ${t}`);
        }
      });
      const pageH = document.documentElement.scrollHeight;
      const viewH = window.innerHeight;
      return { pageH, viewH, items: out };
    })
    .catch(() => ({ pageH: 0, viewH: 0, items: [] }));
  log(`${label}: pageHeight=${inv.pageH}px viewport=${inv.viewH}px (screens: ${(inv.pageH / inv.viewH).toFixed(2)})`);
  inv.items.slice(0, 60).forEach((i) => notes.push(`  ${i}`));
  return inv;
}

const MOBILE = { width: 390, height: 1300 };
const DESKTOP = { width: 1440, height: 1200 };
const TABLET = { width: 834, height: 1300 };

// ------------------------------------------------------------------
// 01-02: first run / empty state
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  log(`01 version marker: model select visible? ${await visible(page, 'eb-model-select')}`);
  log(`01 current-draft label: ${await textOf(page, 'eb-current-draft')}`);
  await snap(page, '01-empty-mobile.png');
  await inventory(page, '01-empty-mobile');
  await page.close();
}

{
  const page = await newPage(DESKTOP);
  await page.goto(`${BASE}/?seed=empty`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  await snap(page, '02-empty-desktop.png');
  await inventory(page, '02-empty-desktop');
  await page.close();
}

// ------------------------------------------------------------------
// 03-07: interview chat mechanics on empty (mock host has no text
// replies, so turns end in the app's no-reply outcome — screenshot it)
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);

  // Type a message, then press Enter.
  await page.click('[data-testid="eb-chat-input"]');
  await page.type(
    '[data-testid="eb-chat-input"]',
    'I want to announce our spring product launch to existing customers',
  );
  // Is Send enabled? (sendChat disabled until input non-empty)
  const sendEnabled = await page
    .$eval('[data-testid="eb-send"]', (el) => !el.disabled)
    .catch(() => false);
  log(`03 send-enabled-after-type=${sendEnabled}`);
  await snap(page, '03-interview-typed-mobile.png');

  await page.keyboard.press('Enter');
  await settle(1800);
  log(`04 after-enter notice: ${await textOf(page, 'eb-notice')}`);
  log(`04 transcript tail visible; confirm absent? ${!(await visible(page, 'eb-confirm'))}`);
  await snap(page, '04-interview-after-enter-mobile.png');

  // Second turn via Send button.
  await page.click('[data-testid="eb-chat-input"]');
  await page.type('[data-testid="eb-chat-input"]', 'Make it friendly and short, CTA: Try it free');
  await page.click('[data-testid="eb-send"]');
  await settle(1800);
  await snap(page, '05-interview-second-turn-mobile.png');
  log(`05 transcript: ${await textOf(page, 'eb-transcript')}`);
  await inventory(page, '05-interview-second-turn');

  // Model picker: open it, read options.
  const options = await page
    .$$eval('[data-testid="eb-model-select"] option', (els) =>
      els.map((o) => `${o.value} (${o.textContent})`),
    )
    .catch(() => []);
  log(`06 model options: ${JSON.stringify(options)}`);
  const modelValue = await page.$eval('[data-testid="eb-model-select"]', (el) => el.value).catch(() => null);
  log(`06 model default: ${modelValue}`);
  await snap(page, '06-model-picker-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 08-17: package-ready state via the sanctioned demo seed
// ------------------------------------------------------------------
{
  const page = await newPage(DESKTOP);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  await snap(page, '08-demo-desktop.png');
  await inventory(page, '08-demo-desktop');
  log(`08 brief card: ${await textOf(page, 'eb-brief')}`);
  await page.close();
}

{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  await snap(page, '09-demo-mobile.png');
  log(`09 draft widget present? ${await visible(page, 'eb-draft-widget')}`);
  log(`09 widget text: ${await textOf(page, 'eb-draft-widget')}`);

  // Pick variant 2 from the chat widget, watch the preview.
  const before = await textOf(page, 'eb-preview');
  await page.click('[data-testid="eb-widget-variant-variant-2"]').catch((e) =>
    log(`09 widget variant click failed: ${e.message}`),
  );
  await settle(700);
  const after = await textOf(page, 'eb-preview');
  log(`09 preview changed via widget pick: ${before !== after}`);
  await snap(page, '10-widget-variant-switch-mobile.png');

  // Subject picking.
  const subjectCount = await page.$$eval('[data-testid^="eb-subject-"]', (els) => els.length).catch(() => 0);
  log(`11 subject options: ${subjectCount}`);
  const picked = await page
    .click('[data-testid="eb-subject-1"]')
    .then(() => true)
    .catch(() => false);
  if (picked) {
    await settle(500);
    const previewSubject = await page
      .$eval('[data-testid="eb-preview"]', (el) => (el.innerText || '').slice(0, 120))
      .catch(() => '');
    log(`11 after subject pick, preview top: ${previewSubject.replace(/\n/g, ' | ')}`);
    await snap(page, '11-subject-picked-mobile.png');
  }
  await page.close();
}

// Manual editor fields -> live preview (demo state, mobile)
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  const editCard = await textOf(page, 'eb-edit');
  log(`12 edit card labels: ${editCard}`);
  // Headline field, body textarea, CTA
  const headline = await page.$eval('[data-testid="eb-headline"]', (el) => el.value).catch(() => null);
  const body = await page.$eval('[data-testid="eb-body"]', (el) => el.value).catch(() => null);
  const cta = await page.$eval('[data-testid="eb-cta"]', (el) => el.value).catch(() => null);
  log(`12 headline=${JSON.stringify(headline)} body=${JSON.stringify(body)} cta=${JSON.stringify(cta)}`);
  await page.click('[data-testid="eb-headline"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.type('[data-testid="eb-headline"]', 'Edited headline by hand');
  await settle(600);
  const previewHeadlineVisible = await page
    .evaluate(() => document.querySelector('[data-testid="eb-preview"]')?.innerText.includes('Edited headline by hand'))
    .catch(() => false);
  log(`12 preview updated from manual edit: ${previewHeadlineVisible}`);
  await snap(page, '12-manual-edit-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 13-16: banner confirm + in-flight + result, on demo (desktop)
// ------------------------------------------------------------------
{
  const page = await newPage(DESKTOP);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  const bannerBtn = await textOf(page, 'eb-banner-generate').catch(() => null);
  log(`13 banner button: ${bannerBtn}`);
  await page.click('[data-testid="eb-banner-generate"]').catch((e) =>
    log(`13 banner click failed: ${e.message}`),
  );
  await settle(2000);
  log(`13 confirm card: ${await textOf(page, 'eb-confirm')}`);
  log(`13 confirm in viewport? ${await page.evaluate(() => {
    const el = document.querySelector('[data-testid="eb-confirm"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  })}`);
  await snap(page, '13-banner-confirm-desktop.png');

  // Confirm it (mock host, no real Buzz).
  await page.click('[data-testid="eb-confirm-run"]').catch((e) =>
    log(`13 confirm-run failed: ${e.message}`),
  );
  await settle(900);
  log(`13 in-flight (any busy/notice): notice=${await textOf(page, 'eb-notice')} flash=${await textOf(page, 'eb-flash')}`);
  await snap(page, '14-banner-inflight-desktop.png');
  await settle(5000);
  const imgPresent = await page.$('[data-testid="eb-banner-img"]').then((h) => !!h).catch(() => false);
  const noticeAfter = await textOf(page, 'eb-notice');
  const flashAfter = await textOf(page, 'eb-flash');
  log(`13 banner done: img=${imgPresent} notice=${noticeAfter} flash=${flashAfter}`);
  await snap(page, '15-banner-result-desktop.png');
  await page.close();
}

// ------------------------------------------------------------------
// 16-18: refine by chat + export, on demo (mobile)
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  await page.click('[data-testid="eb-chat-input"]');
  await page.type('[data-testid="eb-chat-input"]', 'Make the headline punchier');
  await page.click('[data-testid="eb-send"]');
  await settle(2200);
  log(`16 refine outcome notice: ${await textOf(page, 'eb-notice')}`);
  log(`16 refine transcript: ${await textOf(page, 'eb-transcript')}`);
  await snap(page, '16-refine-outcome-mobile.png');

  // Export controls
  const copyLabel = await page.$eval('[data-testid="eb-copy-html"]', (el) => el.innerText.trim()).catch(() => null);
  const dlLabel = await page.$eval('[data-testid="eb-download-html"]', (el) => el.innerText.trim()).catch(() => null);
  log(`17 export labels: copy=${JSON.stringify(copyLabel)} download=${JSON.stringify(dlLabel)}`);
  if (copyLabel) {
    await page.click('[data-testid="eb-copy-html"]').catch(() => {});
    await settle(800);
    log(`17 after copy click: flash=${await textOf(page, 'eb-flash')} notice=${await textOf(page, 'eb-notice')}`);
  }
  await snap(page, '17-export-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 19-26: drafts lifecycle, on demo (mobile), storage seeded draft
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1500);
  const draftsCard = await textOf(page, 'eb-drafts');
  log(`19 drafts card: ${draftsCard}`);
  await snap(page, '19-drafts-mobile.png');

  // Save the current draft
  await page.click('[data-testid="eb-save-draft"]').catch((e) => log(`19 save failed: ${e.message}`));
  await settle(1200);
  log(`19 after save: flash=${await textOf(page, 'eb-flash')} drafts=${await textOf(page, 'eb-drafts')}`);

  // Duplicate the seeded draft (its id is 'demo-1')
  const dupOk = await page
    .click('[data-testid="eb-duplicate-demo-1"]')
    .then(() => true)
    .catch(() => false);
  log(`20 duplicate clicked: ${dupOk}`);
  await settle(800);
  log(`20 drafts after duplicate: ${await textOf(page, 'eb-drafts')}`);

  // Rename: open, inspect prefilled value + selection behaviour
  const renameOk = await page
    .click('[data-testid="eb-rename-demo-1"]')
    .then(() => true)
    .catch(() => false);
  log(`21 rename opened: ${renameOk}`);
  if (renameOk) {
    await settle(400);
    const val = await page.$eval('[data-testid="eb-rename-input"]', (el) => el.value).catch(() => null);
    const sel = await page
      .evaluate(() => {
        const el = document.querySelector('[data-testid="eb-rename-input"]');
        return el ? { start: el.selectionStart, end: el.selectionEnd, len: el.value.length } : null;
      })
      .catch(() => null);
    log(`21 rename prefill=${JSON.stringify(val)} selection=${JSON.stringify(sel)}`);
    await page.type('[data-testid="eb-rename-input"]', ' renamed');
    await settle(300);
    const joined = await page.$eval('[data-testid="eb-rename-input"]', (el) => el.value).catch(() => null);
    log(`21 rename typed value: ${JSON.stringify(joined)}`);
    await page.click('[data-testid="eb-rename-save"]').catch(() => {});
    await settle(800);
    log(`21 drafts after rename: ${await textOf(page, 'eb-drafts')}`);
  }
  await snap(page, '21-drafts-after-ops-mobile.png');

  // Two-tap delete
  const delOk = await page
    .click('[data-testid="eb-delete-demo-1"]')
    .then(() => true)
    .catch(() => false);
  await settle(400);
  log(`22 delete first tap: drafts=${await textOf(page, 'eb-drafts')}`);
  if (delOk) await snap(page, '22-delete-armed-mobile.png');
  await page.click('[data-testid="eb-delete-demo-1"]').catch(() => {});
  await settle(800);
  log(`22 after delete: drafts=${await textOf(page, 'eb-drafts')}`);
  await snap(page, '23-after-delete-mobile.png');

  // New email
  await page.click('[data-testid="eb-new"]').catch(() => {});
  await settle(700);
  log(`24 after New: current-draft=${await textOf(page, 'eb-current-draft')}`);
  await snap(page, '24-after-new-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 25-28: walls — anon, consent, insufficient, low balance
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty&viewer=anon`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  log(`25 anon signin button visible? ${await visible(page, 'eb-signin')}`);
  await snap(page, '25-anon-mobile.png');
  await page.click('[data-testid="eb-chat-input"]');
  await page.type('[data-testid="eb-chat-input"]', 'Hello, I want an email');
  await page.click('[data-testid="eb-send"]');
  await settle(1500);
  log(`25 anon send outcome: notice=${await textOf(page, 'eb-notice')}`);
  await snap(page, '26-anon-send-mobile.png');
  await page.close();
}

{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty&consent=ungrantable`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  await page.click('[data-testid="eb-chat-input"]');
  await page.type('[data-testid="eb-chat-input"]', 'Launch announcement please');
  await page.click('[data-testid="eb-send"]');
  await settle(1800);
  log(`27 consent-ungrantable notice: ${await textOf(page, 'eb-notice')}`);
  await snap(page, '27-consent-ungrantable-mobile.png');
  await page.close();
}

{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty&fail=insufficient`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  await page.click('[data-testid="eb-chat-input"]');
  await page.type('[data-testid="eb-chat-input"]', 'Launch announcement please');
  await page.click('[data-testid="eb-send"]');
  await settle(2500);
  log(`28 insufficient notice: ${await textOf(page, 'eb-notice')}`);
  await snap(page, '28-insufficient-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 29-32: palettes on empty + demo (desktop spot check)
// ------------------------------------------------------------------
for (const [pid, tag] of [
  ['letterpress', 'letterpress'],
  ['newsroom', 'newsroom'],
  ['violet-circuit', 'violet'],
  ['coral-post', 'coral'],
]) {
  const page = await newPage(DESKTOP);
  await page.goto(`${BASE}/?seed=demo&palette=${pid}`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  const applied = await page
    .$eval('[data-testid="eb-app"]', (el) => el.getAttribute('data-palette'))
    .catch(() => null);
  log(`29-32 palette ${pid} applied on root: ${applied}`);
  await snap(page, `29-palette-${tag}-desktop.png`);
  await page.close();
}

{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty&palette=letterpress`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1200);
  await snap(page, '30-palette-letterpress-empty-mobile.png');
  await page.close();
}

{
  const page = await newPage(TABLET);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  await snap(page, '31-demo-tablet.png');
  await page.close();
}

fs.writeFileSync(path.join(OUT, '_notes.json'), JSON.stringify({ notes, problems }, null, 2));
console.log('pageerrors:', problems.length ? problems : 'none');
await browser.close();
console.log('done');
