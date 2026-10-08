// Toil-Killer headless proof — Open Datasets binding (mock harness
// only — no live origin, no Buzz). Proves the generalized extension:
//   (a) the app picker defaults to Email Builder, switches to Open
//       Datasets, and the panel's catalog hash matches
//       steps-open-datasets.json (13 steps, extension v0.6.0);
//   (b) the main run walks all six Open Datasets screens (Explore,
//       dataset detail, scratch create/edit/contribute, Train price
//       card, LoRA detail, test-generation card, ledger) with Auto
//       ON under a 1000-Buzz cap — the price cards are confirmed by
//       the runner against the mock host under the owner's opt-in;
//   (c) run-end cleanup deletes the run's toil-scratch-* dataset and
//       the report states AUTO MODE + the cleanup truthfully;
//   (d) the walls run: guest + insufficient PASS on their
//       manufactured harness states; consent ends LIVE-LIMITED with
//       the wall text verbatim, never clicked.
//
// Run:  node tools/walk-extension/proof/proof-runner-open-datasets.mjs
// Boots the dataset-commons mock harness itself if nothing is
// serving :5186. Run SEQUENTIALLY with proof-runner.mjs — both
// harnesses use :5186.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXT_DIR = path.join(APP_DIR, 'tools', 'walk-extension');
const DATASET_DIR = path.resolve(APP_DIR, '..', 'dataset-commons');
const BASE = 'http://localhost:5186';
const CHROME = '/home/hatch/workspace/.cft/chrome-linux64/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(label, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// --- harness lifecycle -------------------------------------------------
async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
let serverProc = null;
async function ensureServer() {
  if (await serverUp()) return false;
  serverProc = spawn('npm', ['run', 'dev:harness'], {
    cwd: DATASET_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    if (await serverUp()) return true;
    if (serverProc.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error('dataset-commons dev:harness did not come up');
}

console.log('== (a) Open Datasets catalog + generalized panel ==');
const catalogPath = path.join(EXT_DIR, 'steps-open-datasets.json');
const expectedHash = createHash('sha256').update(fs.readFileSync(catalogPath)).digest('hex');
console.log(`  steps-open-datasets.json sha256: ${expectedHash.slice(0, 16)}…`);
const manifestVersion = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version;
assert('extension manifest is 0.6.0', manifestVersion === '0.6.0', manifestVersion);

const bootedByUs = await ensureServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-features=AllowInsecureLocalhost',
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

// harness tab first, so the panel's target discovery can find it.
// Seeded mock scenario via URL knobs (no remount): the demo dataset
// plus a training run that finishes with a published LoRA linked.
const harness = await browser.newPage();
const MOCK_IMG_SVG = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>` +
    `<rect width='1024' height='576' fill='#1971c2'/>` +
    `<text x='512' y='290' font-family='Arial' font-size='72' font-weight='700' fill='white' text-anchor='middle'>MOCK</text></svg>`,
);
await harness.setRequestInterception(true);
harness.on('request', (req) => {
  const url = req.url();
  if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
    void req.continue();
  } else if (req.resourceType() === 'image') {
    void req.respond({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMG_SVG });
  } else {
    void req.abort();
  }
});
await harness.goto(`${BASE}/?community=demo&training=published`, { waitUntil: 'networkidle2', timeout: 60_000 });
const dcReady = await harness.waitForSelector('[data-testid="dc-explore-search"]', { timeout: 30_000 }).catch(() => null);
assert('dataset-commons mock harness boots on :5186 (no other app is serving the port)', Boolean(dcReady));
await sleep(1500);

const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'load', timeout: 30_000 });

const ebLine = await panel.waitForFunction(
  () => {
    const el = document.getElementById('catalogLine');
    return el && el.textContent.includes('sha256') ? el.textContent : null;
  },
  { timeout: 20_000 },
).then((h) => h.jsonValue());
assert('panel defaults to the Email Builder binding', ebLine.startsWith('Email Builder'), ebLine);

// pick Open Datasets and let the catalog load
await panel.evaluate(() => {
  const sel = document.getElementById('appSelect');
  sel.value = 'open-datasets';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
const odLine = await panel.waitForFunction(
  (hashPrefix) => {
    const el = document.getElementById('catalogLine');
    return el && el.textContent.includes('Open Datasets') && el.textContent.includes(hashPrefix)
      ? el.textContent : null;
  },
  { timeout: 20_000 },
  `sha256 ${expectedHash.slice(0, 12)}`,
).then((h) => h.jsonValue()).catch(() => null);
console.log(`  panel catalog line: ${odLine ?? '(never loaded)'}`);
assert('panel Open Datasets catalog hash matches steps-open-datasets.json', Boolean(odLine));
assert('panel reports the Open Datasets catalog in sync', Boolean(odLine?.includes('✓ sync')));
assert('panel shows 13 Open Datasets steps', Boolean(odLine?.includes('13 steps')));
assert('panel shows extension v0.6.0', Boolean(odLine?.includes('extension v0.6.0')));

// target auto-discovery: the harness tab, dc-community seen
await panel.waitForFunction(
  () => {
    const opt = document.getElementById('targetSelect')?.selectedOptions?.[0];
    return opt && opt.textContent.includes('dc-community') && opt.textContent.includes('localhost:5186');
  },
  { timeout: 25_000 },
).catch(async () => {
  await panel.evaluate(() => document.getElementById('btnTargets').click());
  await panel.waitForFunction(
    () => {
      const opt = document.getElementById('targetSelect')?.selectedOptions?.[0];
      return opt && opt.textContent.includes('dc-community') && opt.textContent.includes('localhost:5186');
    },
    { timeout: 25_000 },
  );
});
assert('panel auto-selected the harness tab (dc-community frame)', true);

// --- panel driving helpers ----------------------------------------------
async function setGroups(names) {
  await panel.evaluate((wanted) => {
    for (const box of document.querySelectorAll('#groupList input[type="checkbox"]')) {
      const on = wanted.includes(box.dataset.group);
      if (box.checked !== on) {
        box.checked = on;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, names);
}
async function runAndWait(timeoutMs) {
  await panel.evaluate(() => document.getElementById('btnWalkRun').click());
  await panel.waitForFunction(
    () => window.__tkWalk && window.__tkWalk.status === 'done',
    { timeout: timeoutMs },
  );
  return panel.evaluate(() => window.__tkWalk);
}
function logRun(w) {
  for (const r of w?.records ?? []) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.label).join('; ');
    console.log(`    ${r.id}: ${r.status}${failed ? ` (failed checks: ${failed})` : ''}${r.errors.length ? ` errors: ${r.errors.join(' | ')}` : ''}`);
    if (r.status !== 'pass' && r.notes.length) console.log(`      notes: ${r.notes.join(' | ')}`);
  }
}

// --- (b) main run --------------------------------------------------------
console.log('== (b) main run: all six Open Datasets screens, Auto-gated prices ==');
await setGroups(['explore', 'dataset', 'create', 'train', 'lora', 'ledger']);
await panel.evaluate(() => {
  const scratch = document.getElementById('optScratch');
  if (!scratch.checked) { scratch.checked = true; scratch.dispatchEvent(new Event('change', { bubbles: true })); }
  const auto = document.getElementById('optAuto');
  if (!auto.checked) { auto.checked = true; auto.dispatchEvent(new Event('change', { bubbles: true })); }
  const cap = document.getElementById('optAutoCap');
  cap.value = '1000';
  cap.dispatchEvent(new Event('change', { bubbles: true }));
});
const main = await runAndWait(420_000).catch(() => null);
assert('main run: run finishes', Boolean(main));
logRun(main);
const byId = Object.fromEntries((main?.records ?? []).map((r) => [r.id, r]));
for (const id of ['od-explore', 'od-dataset-detail', 'od-scratch-create', 'od-scratch-edit-contribute',
  'od-train-confirm', 'od-train-outcome', 'od-lora-detail', 'od-lora-test-confirm',
  'od-lora-test-outcome', 'od-ledger']) {
  assert(`${id} passes`, byId[id]?.status === 'pass', byId[id]?.status ?? '(missing)');
}
assert('scratch dataset carries the toil-scratch- containment marker',
  Boolean(main?.scratch?.name?.startsWith('toil-scratch-')), main?.scratch?.name ?? '(none)');

// --- (c) cleanup + report honesty ---------------------------------------
console.log('== (c) scratch cleanup + report honesty ==');
assert('run-end cleanup deletes the scratch dataset',
  (main?.cleanup?.deleted ?? []).length === 1 && (main?.cleanup?.failed ?? []).length === 0,
  JSON.stringify(main?.cleanup ?? null));
assert('cleanup reports no leftovers', (main?.cleanup?.failed ?? []).length === 0,
  JSON.stringify(main?.cleanup?.failed ?? null));
const bundle = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return b ? { names: b.files.map((f) => f.path), reportMd: b.reportMd } : null;
});
assert('report is titled for Open Datasets', Boolean(bundle?.reportMd?.includes('# Open Datasets walk')));
assert('report states AUTO MODE truthfully',
  Boolean(bundle?.reportMd?.includes('AUTO MODE')) && Boolean(bundle?.reportMd?.includes('cap 1000')));
assert('report records the scratch cleanup',
  Boolean(bundle?.reportMd?.includes('cleanup: deleted')) && Boolean(bundle?.reportMd?.includes('toil-scratch-')));
assert('bundle carries report + strips',
  ['report.md', 'strip.html', 'taste-strip.html'].every((n) => bundle?.names?.includes(n)),
  (bundle?.names ?? []).join(', '));

// --- (d) walls ------------------------------------------------------------
console.log('== (d) walls: guest + insufficient manufactured; consent verbatim, never clicked ==');
await setGroups(['walls']);
const walls = await runAndWait(300_000).catch(() => null);
assert('walls run: run finishes', Boolean(walls));
logRun(walls);
const wallById = Object.fromEntries((walls?.records ?? []).map((r) => [r.id, r]));
assert('od-wall-guest passes on the anonymous harness', wallById['od-wall-guest']?.status === 'pass', wallById['od-wall-guest']?.status ?? '(missing)');
assert('od-wall-insufficient passes on the zero-balance harness', wallById['od-wall-insufficient']?.status === 'pass', wallById['od-wall-insufficient']?.status ?? '(missing)');
assert('od-wall-consent ends LIVE-LIMITED at the consent wall',
  wallById['od-wall-consent']?.status === 'live-limited' && wallById['od-wall-consent']?.wall === 'consent',
  JSON.stringify(wallById['od-wall-consent'] ?? null));

await browser.close();
if (bootedByUs && serverProc) {
  try { process.kill(-serverProc.pid, 'SIGTERM'); } catch { /* already gone */ }
}
console.log(failures ? `\nOPEN DATASETS PROOF: ${failures} FAILURE(S)` : '\nOPEN DATASETS PROOF: ALL PASS');
process.exit(failures ? 1 : 0);
