// Email Builder v0.1.6 UX verification captures (dev-only, mock harness, no real Buzz).
// Verifies Zacx's 2026-10-05 feedback: (1) present things incrementally as they
// gain content (no empty Brief/preview shells), (2) responsive + full width,
// (3) chat front and center, next step obvious.
//
//   npm run dev:harness   (another terminal, port 5186)
//   node tools/ux-v016-captures.mjs

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
const DL = '/tmp/eb-v016-downloads';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DL, { recursive: true });

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

const MOBILE = { width: 390, height: 1300 };
const TABLET = { width: 834, height: 1300 };
const DESKTOP = { width: 1440, height: 1200 };

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
  await settle(450);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('captured', name);
}

async function exists(page, testid) {
  return page.$(`[data-testid="${testid}"]`).then((h) => !!h).catch(() => false);
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
async function geo(page, label) {
  const m = await page
    .evaluate(() => {
      const vw = window.innerWidth;
      const app = document.querySelector('[data-testid="eb-app"]');
      const chatCol = app?.querySelector(':scope > div > div')?.children?.[0];
      const firstCard = document.querySelector('[data-testid="eb-transcript"]')?.closest('div');
      const shell = app?.getBoundingClientRect();
      return {
        vw,
        scrollW: document.documentElement.scrollWidth,
        shellLeft: shell ? Math.round(shell.left) : null,
        shellRight: shell ? Math.round(vw - shell.right) : null,
        shellWidth: shell ? Math.round(shell.width) : null,
        colCount: chatCol ? document.querySelectorAll('[data-testid="eb-app"] > div > div > div > div').length : null,
      };
    })
    .catch(() => null);
  log(`${label} geometry: ${JSON.stringify(m)}`);
  return m;
}
async function overflowCheck(page, label) {
  const o = await page
    .evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }))
    .catch(() => ({ sw: -1, iw: -1 }));
  log(`${label} horizontal overflow: scrollWidth=${o.sw} innerWidth=${o.iw} overflow=${o.sw > o.iw}`);
  return o.sw <= o.iw;
}

// ------------------------------------------------------------------
// 1. Empty state, all three viewports — is chat the unmistakable front door?
// ------------------------------------------------------------------
for (const [vp, name] of [
  [MOBILE, '01-empty-mobile.png'],
  [TABLET, '02-empty-tablet.png'],
  [DESKTOP, '03-empty-desktop.png'],
]) {
  const page = await newPage(vp);
  await page.goto(`${BASE}/?seed=empty`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  log(`${name}: eb-brief present in DOM? ${await exists(page, 'eb-brief')} · eb-preview present? ${await exists(page, 'eb-preview')} · eb-drafts present? ${await exists(page, 'eb-drafts')} (header=${JSON.stringify(await textOf(page, 'eb-drafts'))}) · eb-next-generate? ${await exists(page, 'eb-next-generate')} · send disabled-quiet? ${await page.$eval('[data-testid="eb-send"]', (el) => el.disabled).catch(() => null)}`);
  const g = await geo(page, name);
  // centered check on wide screens: chat wrapper column width
  const col = await page
    .evaluate(() => {
      const app = document.querySelector('[data-testid="eb-app"]');
      const cols = app?.querySelectorAll(':scope > div > div > div');
      const out = [];
      cols?.forEach((c) => {
        const r = c.getBoundingClientRect();
        out.push({ w: Math.round(r.width), left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) });
      });
      return out;
    })
    .catch(() => null);
  log(`${name} columns: ${JSON.stringify(col)}`);
  await overflowCheck(page, name);
  await snap(page, name);
  await page.close();
}

// ------------------------------------------------------------------
// 2. First message + Enter on empty (mobile): outcome note in transcript,
//    page still has nothing empty on it.
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=empty`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1300);
  await page.click('[data-testid="eb-chat-input"]');
  await page.type(
    '[data-testid="eb-chat-input"]',
    'I want to announce our spring product launch to existing customers',
  );
  await page.keyboard.press('Enter');
  await settle(2200);
  log(`04 after Enter: notice=${JSON.stringify(await textOf(page, 'eb-notice'))}`);
  log(`04 transcript: ${JSON.stringify(await textOf(page, 'eb-transcript'))}`);
  log(`04 eb-brief appeared? ${await exists(page, 'eb-brief')} · eb-preview? ${await exists(page, 'eb-preview')}`);
  await overflowCheck(page, '04');
  await snap(page, '04-empty-after-send-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 3. Demo (package-ready) at all viewports — full-width + hierarchy.
// ------------------------------------------------------------------
const demoGeom = {};
for (const [vp, name] of [
  [MOBILE, '05-demo-mobile.png'],
  [TABLET, '06-demo-tablet.png'],
  [DESKTOP, '07-demo-desktop.png'],
]) {
  const page = await newPage(vp);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  const g = await geo(page, name);
  demoGeom[name] = g;
  log(`${name}: brief card text: ${JSON.stringify(await textOf(page, 'eb-brief'))}`);
  log(`${name}: widget present? ${await visible(page, 'eb-draft-widget')} text=${JSON.stringify(await textOf(page, 'eb-draft-widget'))}`);
  log(`${name}: width-toggle segmented present? ${await page.evaluate(() => {
    const card = document.querySelector('[data-testid="eb-preview"]');
    return card ? [...card.querySelectorAll('*')].some((e) => e.textContent?.trim() === 'Desktop' || e.textContent?.trim() === 'Mobile') : false;
  })}`);
  await overflowCheck(page, name);
  await snap(page, name);
  await page.close();
}

// ------------------------------------------------------------------
// 4+5. Widget variant pick, then editor variant + subject picks (mobile).
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  const before = await textOf(page, 'eb-preview');
  await page.click('[data-testid="eb-widget-variant-variant-2"]').catch((e) =>
    log(`08 widget click failed: ${e.message}`),
  );
  await settle(700);
  const after = await textOf(page, 'eb-preview');
  log(`08 preview changed via widget pick: ${before !== after}; now starts: ${JSON.stringify((after || '').slice(0, 90))}`);
  await snap(page, '08-widget-variant-switch-mobile.png');

  // Editor-side picks: subject 1, then variant back to 1 via editor button.
  await page.click('[data-testid="eb-subject-1"]').catch((e) => log(`09 subject click failed: ${e.message}`));
  await settle(500);
  log(`09 after subject-1 pick, editor Subject field: ${await page.$eval('[data-testid="eb-edit"] input[aria-label="Subject"]', (el) => el.value).catch(() => null)}`);
  await page.click('[data-testid="eb-variant-variant-1"]').catch((e) => log(`09 variant click failed: ${e.message}`));
  await settle(500);
  log(`09 preview after editor picks: ${JSON.stringify((await textOf(page, 'eb-preview') || '').slice(0, 90))}`);
  await snap(page, '09-editor-picks-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 6. Model toggle: expand, switch, collapse (mobile).
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  log(`10 toggle label before: ${JSON.stringify(await textOf(page, 'eb-model-toggle'))} · select present pre-open? ${await exists(page, 'eb-model-select')}`);
  await page.click('[data-testid="eb-model-toggle"]');
  await settle(500);
  const opts = await page.$$eval('[data-testid="eb-model-select"] option', (els) =>
    els.map((o) => `${o.value} (${o.textContent})`),
  ).catch(() => []);
  log(`10 options: ${JSON.stringify(opts)}`);
  await page.select('[data-testid="eb-model-select"]', 'deepseek/deepseek-chat').catch((e) => log(`10 select failed: ${e.message}`));
  await settle(400);
  log(`10 toggle label after switch: ${JSON.stringify(await textOf(page, 'eb-model-toggle'))}`);
  await snap(page, '10-model-picker-expanded-mobile.png');
  await page.click('[data-testid="eb-model-toggle"]');
  await settle(400);
  log(`10 select present post-collapse? ${await exists(page, 'eb-model-select')}`);
  await page.close();
}

// ------------------------------------------------------------------
// 7. Brief expanded + Regenerate confirm/cancel (mobile); banner confirm (desktop).
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  await page.click('[data-testid="eb-brief-toggle"]');
  await settle(500);
  log(`11 brief expanded: ${JSON.stringify(await textOf(page, 'eb-brief'))}`);
  log(`11 generate label: ${JSON.stringify(await textOf(page, 'eb-generate-bundle'))}`);
  await snap(page, '11-brief-expanded-mobile.png');
  await page.click('[data-testid="eb-generate-bundle"]');
  await settle(1600);
  const confirmText = await textOf(page, 'eb-confirm');
  log(`12 regenerate confirm: ${JSON.stringify(confirmText)}`);
  const inView = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="eb-confirm"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= -4 && r.top < window.innerHeight;
  });
  log(`12 confirm in viewport (top): ${inView}`);
  await snap(page, '12-regenerate-confirm-mobile.png');
  await page.click('[data-testid="eb-confirm-cancel"]');
  await settle(700);
  log(`12 after cancel: flash=${JSON.stringify(await textOf(page, 'eb-flash'))} notice=${JSON.stringify(await textOf(page, 'eb-notice'))} confirm gone? ${!(await exists(page, 'eb-confirm'))}`);
  await page.close();
}

{
  const page = await newPage(DESKTOP);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  log(`13 banner button: ${JSON.stringify(await textOf(page, 'eb-banner-generate'))}`);
  await page.click('[data-testid="eb-banner-generate"]');
  await settle(1600);
  log(`13 banner confirm: ${JSON.stringify(await textOf(page, 'eb-confirm'))}`);
  await snap(page, '13-banner-confirm-desktop.png');
  await page.click('[data-testid="eb-confirm-cancel"]');
  await settle(600);
  log(`13 after cancel: confirm gone? ${!(await exists(page, 'eb-confirm'))}`);
  await page.close();
}

// ------------------------------------------------------------------
// 8. Manual tweaks → live preview (mobile); width toggle tablet + desktop.
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  await page.click('[data-testid="eb-headline"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.type('[data-testid="eb-headline"]', 'Edited headline by hand');
  await settle(600);
  const inPreview = await page.evaluate(
    () => document.querySelector('[data-testid="eb-preview"]')?.innerText.includes('Edited headline by hand'),
  );
  log(`14 preview updated from manual headline edit: ${inPreview}`);
  await snap(page, '14-manual-edit-mobile.png');
  await page.close();
}

for (const [vp, tag] of [
  [TABLET, '15-preview-mobile-width-tablet.png'],
  [DESKTOP, '16-preview-desktop-width-desktop.png'],
]) {
  const page = await newPage(vp);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  const toggled = await page
    .evaluate(() => {
      const card = document.querySelector('[data-testid="eb-preview"]');
      const btn = [...(card?.querySelectorAll('button, [role="radio"]') ?? [])].find(
        (b) => b.textContent?.trim() === 'Mobile',
      );
      if (btn) { btn.click(); return true; }
      return false;
    })
    .catch(() => false);
  await settle(700);
  const canvasW = await page
    .evaluate(() => {
      const img = document.querySelector('[data-testid="eb-preview"] > div > div');
      return img ? Math.round(img.getBoundingClientRect().width) : null;
    })
    .catch(() => null);
  log(`${tag}: 'Mobile' toggle clicked=${toggled} preview canvas width=${canvasW}`);
  await overflowCheck(page, tag);
  await snap(page, tag);
  await page.close();
}

// ------------------------------------------------------------------
// 9. Export: copy + download (mobile).
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1400);
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => {});
  await page.click('[data-testid="eb-download-html"]').catch((e) => log(`17 download click failed: ${e.message}`));
  await settle(1200);
  const files = fs.readdirSync(DL);
  log(`17 downloaded files: ${JSON.stringify(files)}`);
  await page.click('[data-testid="eb-copy-html"]').catch(() => {});
  await settle(900);
  log(`17 after copy: flash=${JSON.stringify(await textOf(page, 'eb-flash'))} notice=${JSON.stringify(await textOf(page, 'eb-notice'))} copy label=${JSON.stringify(await textOf(page, 'eb-copy-html'))}`);
  await snap(page, '17-export-mobile.png');
  await page.close();
}

// ------------------------------------------------------------------
// 10. Drafts lifecycle (mobile, demo): library, marker, menu, rename,
//     duplicate, two-tap delete, save flash, New email.
// ------------------------------------------------------------------
{
  const page = await newPage(MOBILE);
  await page.goto(`${BASE}/?seed=demo`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 30_000 });
  await settle(1500);
  log(`18 drafts card (demo, default): ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);
  await snap(page, '18-drafts-library-mobile.png');

  await page.click('[data-testid="eb-draft-menu-demo-1"]').catch((e) => log(`19 menu failed: ${e.message}`));
  await settle(400);
  log(`19 actions row: ${JSON.stringify(await textOf(page, 'eb-draft-actions-demo-1'))}`);
  await snap(page, '19-draft-menu-mobile.png');

  await page.click('[data-testid="eb-rename-demo-1"]').catch((e) => log(`20 rename failed: ${e.message}`));
  await settle(400);
  const sel = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="eb-rename-input"]');
    return el ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, len: el.value.length } : null;
  }).catch(() => null);
  log(`20 rename prefill+selection: ${JSON.stringify(sel)}`);
  await page.keyboard.down('Control').catch(() => {});
  await page.keyboard.press('a').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.type('[data-testid="eb-rename-input"]', 'Launch v2 final');
  await page.click('[data-testid="eb-rename-save"]').catch(() => {});
  await settle(800);
  log(`20 drafts after rename: ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);
  await snap(page, '20-rename-mobile.png');

  await page.click('[data-testid="eb-draft-menu-demo-1"]').catch(() => {});
  await settle(300);
  await page.click('[data-testid="eb-duplicate-demo-1"]').catch((e) => log(`21 duplicate failed: ${e.message}`));
  await settle(800);
  log(`21 drafts after duplicate: ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);

  await page.click('[data-testid="eb-draft-menu-demo-1"]').catch(() => {});
  await settle(300);
  await page.click('[data-testid="eb-delete-demo-1"]').catch(() => {});
  await settle(400);
  log(`21 delete first tap: ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);
  await snap(page, '21-delete-armed-mobile.png');
  await page.click('[data-testid="eb-delete-demo-1"]').catch(() => {});
  await settle(800);
  log(`21 after delete: ${JSON.stringify(await textOf(page, 'eb-drafts'))}`);

  await page.click('[data-testid="eb-save-draft"]').catch((e) => log(`22 save failed: ${e.message}`));
  await settle(1200);
  log(`22 after save: flash=${JSON.stringify(await textOf(page, 'eb-flash'))}`);

  await page.click('[data-testid="eb-new"]').catch(() => {});
  await settle(800);
  log(`22 after New: current-draft=${JSON.stringify(await textOf(page, 'eb-current-draft'))} eb-brief? ${await exists(page, 'eb-brief')} eb-preview? ${await exists(page, 'eb-preview')} eb-drafts header=${JSON.stringify(await textOf(page, 'eb-drafts'))}`);
  await overflowCheck(page, '22');
  await snap(page, '22-after-new-mobile.png');
  await page.close();
}

fs.writeFileSync(path.join(OUT, '_notes.json'), JSON.stringify({ notes, problems }, null, 2));
console.log('pageerrors:', problems.length ? problems : 'none');
await browser.close();
console.log('done');
