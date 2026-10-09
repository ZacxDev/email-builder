// Toil-Killer headless proof — slow bundle generation (v0.7.4).
// Mock harness only — no live origin, no Buzz.
//
// Live run walk-2026-10-08-1327 failed bundle-outcome: the 107-Buzz
// confirm was auto-confirmed and dismissed, but the app was still
// WORKING (eb-typing) when the executor's fixed 60s+8s clock ran
// out, so a generation merely in flight was graded FAIL. The fix:
// while the app reports working, the wait extends to a 5-minute
// ceiling; still working at the ceiling grades LIVE-LIMITED (spend
// happened, outcome unknown), never PASS, never a false FAIL.
//
// Scenario: the SDK mock host's existing ?latency= knob delays the
// terminal snapshot; the app's own poll schedule reaches it in
// seconds, so latency is the honest "generation still in flight"
// state — eb-typing stays up the whole time, driven purely by the
// app, nothing harness-specific in the executor.
//
//   A) latency 75s (> old 68s window): bundle-outcome must WAIT and
//      PASS, with the waited-while-working note recorded.
//   B) latency 330s (> 300s ceiling): bundle-outcome must end
//      LIVE-LIMITED naming the unknown outcome, not PASS/FAIL,
//      and downstream steps must not run as if a package existed.
// B takes ~5 minutes by design (the ceiling is the thing proven).
//
// Run:  node tools/walk-extension/proof/proof-runner-slow-bundle.mjs

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seededUrl } from '../../walk/seed.mjs';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXT_DIR = path.join(APP_DIR, 'tools', 'walk-extension');
const BASE = 'http://localhost:5186';
const CHROME = '/home/hatch/workspace/.cft/chrome-linux64/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(label, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch { return false; }
}
let serverProc = null;
if (!(await serverUp())) {
  serverProc = spawn('npm', ['run', 'dev:harness'], {
    cwd: APP_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120 && !(await serverUp()); i++) await sleep(500);
  if (!(await serverUp())) throw new Error('dev:harness did not come up');
  console.log('  (booted dev:harness)');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-features=AllowInsecureLocalhost',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});
let sw = null;
for (let i = 0; i < 30 && !sw; i++) {
  sw = (await browser.targets()).find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  );
  if (!sw) await sleep(500);
}
if (!sw) { console.log('NO_SW'); process.exit(1); }
const extId = new URL(sw.url()).host;

const MOCK_IMG_SVG = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>` +
  `<rect width='1024' height='576' fill='#1971c2'/>` +
  `<text x='512' y='290' font-family='Arial' font-size='72' font-weight='700' fill='white' text-anchor='middle'>MOCK</text></svg>`,
);
const harness = await browser.newPage();
await harness.setRequestInterception(true);
harness.on('request', (req) => {
  const url = req.url();
  if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) void req.continue();
  else if (req.resourceType() === 'image') void req.respond({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMG_SVG });
  else void req.abort();
});
await harness.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });

const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'load', timeout: 30_000 });
await panel.waitForFunction(
  () => document.getElementById('targetSelect')?.selectedOptions?.[0]?.textContent.includes('eb-app'),
  { timeout: 30_000, polling: 500 },
).catch(async () => {
  await panel.evaluate(() => document.getElementById('btnTargets').click());
  await panel.waitForFunction(
    () => document.getElementById('targetSelect')?.selectedOptions?.[0]?.textContent.includes('eb-app'),
    { timeout: 30_000, polling: 500 },
  );
});
console.log('  ✓ panel targeted the harness tab');

async function setGroups(wanted) {
  await panel.evaluate((groups) => {
    for (const box of document.querySelectorAll('#groupList input[type="checkbox"]')) {
      const want = groups.includes(box.dataset.group);
      if (box.checked !== want) box.click();
    }
  }, wanted);
}
async function waitWalkDone(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const done = await panel.evaluate(() => window.__tkWalk?.status === 'done');
    if (done) return panel.evaluate(() => window.__tkWalk);
    if (Date.now() - t0 > timeoutMs) throw new Error('walk did not finish in time');
    await sleep(1000);
  }
}
async function runSlowBundle(latencyMs) {
  const url = `${seededUrl(BASE)}&latency=${latencyMs}`;
  // Load the scenario in the harness FIRST: the mock host reads its
  // URL knobs once on mount, and the walk's visit comparison does
  // not treat ?latency as a new visit.
  await harness.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  await panel.evaluate((u) => {
    document.getElementById('seededUrl').value = u;
  }, url);
  await panel.evaluate(() => {
    const on = document.getElementById('optAuto');
    if (on && !on.checked) on.click();
    const cap = document.getElementById('optAutoCap');
    cap.value = '1000';
    cap.dispatchEvent(new Event('change'));
  });
  await setGroups(['bundle']);
  await harness.bringToFront();
  const t0 = Date.now();
  await panel.evaluate(() => document.getElementById('btnWalkRun').click());
  const walk = await waitWalkDone(600_000);
  return { walk, elapsedMs: Date.now() - t0 };
}
const rec = (walk, id) => walk.records.find((r) => r.id === id);

// --- A: slow (75s) generation still passes, and the wait is noted --
console.log('== A) latency 75s: bundle-outcome waits past the old 68s window ==');
const a = await runSlowBundle(75_000);
const aOutcome = rec(a.walk, 'bundle-outcome');
for (const r of a.walk.records) console.log(`  ${r.id}: ${r.status} — ${r.notes.join(' | ').slice(0, 160)}`);
assert('A: bundle-outcome PASS after slow generation', aOutcome?.status === 'pass', aOutcome?.status);
assert('A: the wait outlasted the old fixed window', a.elapsedMs > 70_000, `${Math.round(a.elapsedMs / 1000)}s`);
assert('A: waited-while-working note recorded',
  (aOutcome?.notes ?? []).some((n) => n.includes('while the app reported working')),
  (aOutcome?.notes ?? []).join(' | '));

// --- B: never settles inside the ceiling → LIVE-LIMITED, honest ----
console.log('== B) latency 330s: still working at the 300s ceiling → LIVE-LIMITED ==');
const b = await runSlowBundle(330_000);
const bOutcome = rec(b.walk, 'bundle-outcome');
for (const r of b.walk.records) console.log(`  ${r.id}: ${r.status} — ${r.notes.join(' | ').slice(0, 160)}`);
assert('B: bundle-outcome LIVE-LIMITED (not pass, not fail)', bOutcome?.status === 'live-limited', bOutcome?.status);
assert('B: reason names the unknown outcome after the ceiling',
  (bOutcome?.notes ?? []).some((n) => n.includes('outcome is unknown')),
  (bOutcome?.notes ?? []).join(' | '));
assert('B: reason does not deny the spend',
  (bOutcome?.notes ?? []).some((n) => n.includes('was spent at confirm')),
  (bOutcome?.notes ?? []).join(' | '));
assert('B: downstream preview step did not pass on a package that never landed',
  rec(b.walk, 'finished-preview')?.status !== 'pass',
  rec(b.walk, 'finished-preview')?.status ?? 'not run');

await panel.evaluate(() => {
  const on = document.getElementById('optAuto');
  if (on && on.checked) on.click();
});
await browser.close();
if (serverProc) { try { process.kill(-serverProc.pid, 'SIGTERM'); } catch { /* gone */ } }
console.log(failures === 0 ? '\nPROOF OK — slow-bundle assertions green' : `\nPROOF FAILED — ${failures} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
