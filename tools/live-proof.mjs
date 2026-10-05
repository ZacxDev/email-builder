// Email Builder live proof (dev-only) — drives the REAL app against the REAL
// backend through `npm run dev:live` (createLiveHost + spend-scoped dev token).
// SPENDS REAL BUZZ. Run only with Zacx's explicit go-ahead.
//
//   npm run dev:live        (another terminal, token in .env.development.local)
//   node tools/live-proof.mjs
//
// Flow: one interview turn carrying a complete brief (follow-ups answered
// briefly, max 3 turns) -> Generate email package -> Generate banner.
// Records confirm-card prices + workflow snapshots; screenshots the result.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const CHROME =
  '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.EB_LIVE_BASE ?? 'http://localhost:5186';
const OUT = path.resolve(
  process.env.EB_LIVE_OUT ??
    '/home/hatch/workspace/goals/build-and-publish-apps-that-make-money-24-7/files/app-review/email-builder',
);
fs.mkdirSync(OUT, { recursive: true });

const BRIEF_MESSAGE =
  'I want an email announcing the v2.0 launch of our photo-editing app to our existing free users. ' +
  'Tone: excited but not hypey. The button should say "Try v2 free" and link to https://example.com/v2. ' +
  'Key points: AI background removal that keeps edges clean, and exports that are 2x faster. ' +
  'Signed by "The PhotoApp team". Banner vibe: bright studio photo of a phone showing a before/after edit, no text in the image. ' +
  'That is everything — if the brief is complete, mark it ready.';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 2100 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

// Record workflow snapshots (status + cost) for spend accounting.
await page.evaluateOnNewDocument(() => {
  window.__wf = [];
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && (d.type === 'WORKFLOW_STATUS' || d.type === 'WORKFLOW_SUBMITTED')) {
      const s = d.payload?.snapshot;
      if (s) {
        window.__wf.push({
          workflowId: s.workflowId,
          status: s.status,
          cost: s.cost?.total ?? null,
          imageCount: Array.isArray(s.imageUrls) ? s.imageUrls.length : 0,
          hasText: Array.isArray(s.textOutputs) && s.textOutputs.length > 0,
          error: s.error ?? null,
        });
      }
    }
  });
});
const problems = [];
page.on('pageerror', (e) => problems.push(`[pageerror] ${String(e).slice(0, 200)}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`[console] ${m.text().slice(0, 200)}`);
});

const $ = (sel) => page.$(sel);
const text = async (sel) => {
  const el = await $(sel);
  return el ? el.evaluate((n) => n.textContent ?? '') : null;
};
const notice = async () => (await text('[data-testid="eb-notice"]'))?.trim() || null;

async function waitFor(fn, label, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(1500);
  }
}

/** Click a button, then confirm the priced card; returns the confirm text. */
async function clickAndConfirm(buttonSel, label) {
  await page.click(buttonSel);
  await waitFor(() => $('[data-testid="eb-confirm"]'), `${label} confirm card`, 60_000);
  const confirmText = (await text('[data-testid="eb-confirm"]'))?.trim();
  log(`${label} confirm: ${confirmText}`);
  await page.click('[data-testid="eb-confirm-run"]');
  return confirmText;
}

let failed = null;
try {
  log('loading live app…');
  await page.goto(`${BASE}/`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('[data-testid="eb-app"]', { timeout: 60_000 });
  // Live BLOCK_INIT is a real round trip; wait for the interview input.
  await waitFor(() => $('[data-testid="eb-chat-input"]'), 'chat input', 60_000);
  await sleep(2000);
  const signin = await $('[data-testid="eb-signin"]');
  log('app ready; sign-in button present:', Boolean(signin));

  // --- interview (up to 3 turns) -------------------------------------------
  let bundleEnabled = false;
  for (let turn = 1; turn <= 3; turn++) {
    await page.type(
      '[data-testid="eb-chat-input"]',
      turn === 1 ? BRIEF_MESSAGE : 'That covers everything — please mark the brief ready.',
    );
    await clickAndConfirm('[data-testid="eb-send"]', `interview turn ${turn}`);
    // Wait for the assistant reply to land (Generate enables, or a follow-up).
    try {
      await waitFor(
        async () => {
          const btn = await $('[data-testid="eb-generate-bundle"]');
          if (!btn) return null;
          const disabled = await btn.evaluate((n) => n.disabled);
          return disabled ? null : true;
        },
        'bundle enabled',
        90_000,
      );
      bundleEnabled = true;
    } catch {
      bundleEnabled = false;
    }
    const n = await notice();
    if (n) log(`notice after turn ${turn}: ${n}`);
    if (bundleEnabled) break;
    log(`turn ${turn} done; brief not ready yet`);
  }
  if (!bundleEnabled) throw new Error('brief never became ready after 3 turns');
  log('brief ready:', (await text('[data-testid="eb-brief"]'))?.replace(/\s+/g, ' ').trim());

  // --- bundle ---------------------------------------------------------------
  await clickAndConfirm('[data-testid="eb-generate-bundle"]', 'bundle');
  await waitFor(() => page.$('[data-testid^="eb-variant-"]'), 'variant buttons', 180_000);
  log('variants present; preview headline:', await text('[data-testid="eb-preview"]'));

  // --- banner ---------------------------------------------------------------
  await clickAndConfirm('[data-testid="eb-banner-generate"]', 'banner');
  const img = await waitFor(() => $('[data-testid="eb-banner-img"]'), 'banner img', 240_000);
  const src = await img.evaluate((n) => n.getAttribute('src'));
  log('banner image src host:', src ? new URL(src).host : '(none)');

  // --- refine smoke (one small chat revision) -------------------------------
  await page.type('[data-testid="eb-chat-input"]', 'make the headline shorter');
  await clickAndConfirm('[data-testid="eb-send"]', 'refine');
  await sleep(20_000);

  await page.screenshot({ path: path.join(OUT, 'live-proof-desktop.png') });
  log('screenshot saved');
} catch (err) {
  failed = String(err).slice(0, 300);
  log('FLOW FAILED:', failed);
  await page.screenshot({ path: path.join(OUT, 'live-proof-failure.png') }).catch(() => {});
}

const wf = await page.evaluate(() => window.__wf ?? []);
const finalNotice = await notice();
await browser.close();

console.log('\n=== LIVE PROOF SUMMARY ===');
console.log('failed:', failed ?? 'no');
console.log('final notice:', finalNotice ?? '(none)');
console.log('workflow snapshots (terminal only):');
const terminal = wf.filter((s) => ['succeeded', 'failed', 'expired', 'canceled'].includes(s.status));
for (const s of terminal) console.log(' ', JSON.stringify(s));
console.log(
  'total succeeded cost:',
  terminal.filter((s) => s.status === 'succeeded').reduce((a, s) => a + (s.cost ?? 0), 0),
  'Buzz (sum of terminal snapshot costs; -1 step may show null if host withholds)',
);
if (problems.length) {
  console.log('page problems:');
  for (const p of problems.slice(0, 10)) console.log(' -', p);
}
