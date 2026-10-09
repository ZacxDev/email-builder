// Toil-Killer headless proof — concurrent runs across tabs (v0.7.0).
// Mock harnesses only — no live origin, no Buzz.
//
// Boots BOTH app harnesses at once (Email Builder on :5186, Open
// Datasets on :5187 — the manifest matches both localhost ports so
// the two harnesses can live side by side), opens both app tabs in
// one browser window, and starts a walk on each from the one real
// panel. The walks run CONCURRENTLY: the panel view follows the
// active tab, per-tab contexts keep every run's state apart, and
// screenshots stay honest — the visible tab's steps get real PNGs,
// the hidden tab's steps are graded from the DOM and their missing
// PNGs are named in the report and the ship manifest instead of
// being silently dropped or filled with the wrong tab's pixels.
//
// Proves:
//   (a) two walks in flight at once (Target marks both ▶ running);
//   (b) panel follows the active tab: step list + status swap whole
//       between the two runs, neither disturbed;
//   (c) both runs finish with their single-run verdicts, no step id
//       from one app appears in the other's records;
//   (d) scratch containment per run (walk-scratch-… / toil-scratch-…),
//       each deleted by its own run's cleanup;
//   (e) screenshot honesty: front tab all real shots; hidden tab's
//       later steps carry shotMissing + the note, report names the
//       unavailable PNGs, ship manifest lists missingScreenshots;
//   (f) auto target type (v0.7.1): bringing each harness tab to the
//       front flips appSelect + catalog + groups with no picker
//       interaction, and a no-app tab shows the honest unselected
//       state with Run disabled;
//   (g) screenshot retake (v0.7.5): returning to the hidden tab
//       automatically captures its missing screenshots once,
//       labels them as retaken current-view evidence in the report
//       and ship manifest, and leaves every grade unchanged.
//
// What this cannot prove headlessly: two real browser WINDOWS each
// with their own side panel (panels are per-window instances; a
// second window's panel would follow its own window's tabs the same
// way). Cross-window panel sync is not a feature and not claimed.
//
// Run:  node tools/walk-extension/proof/proof-runner-concurrent.mjs
// (May reuse harnesses already serving :5186/:5187; boots what it
// needs and kills only what it booted.)

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seededUrl } from '../../walk/seed.mjs';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXT_DIR = path.join(APP_DIR, 'tools', 'walk-extension');
const DATASET_DIR = path.resolve(APP_DIR, '..', 'dataset-commons');
const EB = 'http://localhost:5186';
const OD = 'http://localhost:5187';
const CHROME = '/home/hatch/workspace/.cft/chrome-linux64/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(label, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

// --- harness lifecycle -------------------------------------------------
async function serverUp(base) {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}
const booted = [];
async function ensureServer(base, cwd, args, label) {
  if (await serverUp(base)) return;
  const proc = spawn('npx', args, {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_DEV_HARNESS: 'true', VITE_HARNESS_MODE: 'mock' },
  });
  booted.push(proc);
  for (let i = 0; i < 120; i++) {
    if (await serverUp(base)) return;
    if (proc.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`${label} harness did not come up on ${base}`);
}

await ensureServer(EB, APP_DIR, ['vite', '--host', 'localhost', '--port', '5186'], 'email-builder');
await ensureServer(OD, DATASET_DIR, ['vite', '--host', 'localhost', '--port', '5187'], 'dataset-commons');
console.log('== harnesses: email-builder :5186 + open-datasets :5187 ==');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-features=AllowInsecureLocalhost',
    // Proof-only: keep hidden tabs' timers near-normal so the run
    // measures panel concurrency, not Chrome's background throttling.
    // Tab VISIBILITY (what captureVisibleTab sees) is unaffected.
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
async function appPage(base, url) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:')) void req.continue();
    else if (req.resourceType() === 'image') void req.respond({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMG_SVG });
    else void req.abort();
  });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(2500);
  return page;
}

const ebPage = await appPage(EB, `${EB}/`);
const odPage = await appPage(OD, `${OD}/?community=demo&training=published`);
assert('email-builder harness renders eb-app', await ebPage.evaluate(() => document.querySelector('[data-testid="eb-app"]') !== null));
assert('open-datasets harness renders dc-community on :5187', await odPage.evaluate(() => document.querySelector('[data-testid="dc-community"]') !== null));

const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'load', timeout: 30_000 });
await panel.waitForFunction(
  () => document.getElementById('catalogLine')?.textContent.includes('sha256')
    && (document.getElementById('targetSelect')?.options.length ?? 0) >= 2,
  { timeout: 30_000, polling: 500 },
);
console.log('  ✓ panel loaded with both harness tabs in Target');

const tabIds = await panel.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const byOrigin = {};
  for (const t of tabs) {
    if (t.url?.startsWith('http://localhost:5186')) byOrigin.eb = t.id;
    if (t.url?.startsWith('http://localhost:5187')) byOrigin.od = t.id;
  }
  return byOrigin;
});
assert('panel sees both harness tabs', Boolean(tabIds.eb && tabIds.od), JSON.stringify(tabIds));

async function setGroups(wanted) {
  await panel.evaluate((groups) => {
    for (const box of document.querySelectorAll('#groupList input[type="checkbox"]')) {
      const want = groups.includes(box.dataset.group);
      if (box.checked !== want) box.click();
    }
  }, wanted);
}
async function walksByTab() {
  return panel.evaluate(() => window.__tkWalkReport.walksByTab());
}
async function waitBothDone(timeoutMs = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const walks = await walksByTab();
    const eb = walks[tabIds.eb];
    const od = walks[tabIds.od];
    if (eb?.status === 'done' && od?.status === 'done') return walks;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`walks did not both finish within ${timeoutMs}ms — eb=${eb?.status} od=${od?.status}`);
    }
    await sleep(2000);
  }
}

// --- (a) start both walks, EB first (front), then OD (front) --------
console.log('== (a) two walks in flight at once ==');
await ebPage.bringToFront();
await panel.waitForFunction(
  () => document.getElementById('targetSelect')?.selectedOptions?.[0]?.textContent.includes('localhost:5186'),
  { timeout: 20_000, polling: 500 },
);
console.log('  ✓ panel followed the active tab (Email Builder)');
await panel.waitForFunction(
  () => document.getElementById('appSelect').value === 'email-builder'
    && document.getElementById('catalogLine').textContent.includes('Email Builder')
    && document.getElementById('tabInfo').textContent.includes('Auto: Email Builder'),
  { timeout: 20_000, polling: 500 },
);
console.log('  ✓ target type auto-selected Email Builder (no picker interaction)');
await panel.evaluate((url) => { document.getElementById('seededUrl').value = url; }, seededUrl(EB));
// first-run + library: the steps that PASS in the single-app proof
// on this harness (the library-ops steps carry the known eb-new app
// drift and fail there too — identical verdicts are what counts).
await setGroups(['first-run', 'library']);
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
// Wait for EB's first executed record so its first screenshot is
// taken while EB is still the visible tab (deterministic split).
await panel.waitForFunction(
  (tabId) => (window.__tkWalkReport.walksByTab()[tabId]?.records.length ?? 0) >= 1,
  { timeout: 120_000, polling: 500 },
  tabIds.eb,
);
console.log('  ✓ Email Builder walk running (first step recorded)');

// Park Email Builder between steps so "both in flight" is
// deterministic rather than a race against its short subset.
await panel.evaluate(() => document.getElementById('btnWalkPause').click());
await panel.waitForFunction(
  () => document.getElementById('walkStatus').textContent.includes('paused'),
  { timeout: 30_000, polling: 500 },
);
console.log('  ✓ Email Builder run parked mid-flight (paused between steps)');
await odPage.bringToFront();
await panel.waitForFunction(
  () => document.getElementById('targetSelect')?.selectedOptions?.[0]?.textContent.includes('localhost:5187'),
  { timeout: 20_000, polling: 500 },
);
console.log('  ✓ panel followed the active tab (Open Datasets)');
await panel.waitForFunction(
  () => document.getElementById('appSelect').value === 'open-datasets'
    && document.getElementById('catalogLine')?.textContent.includes('Open Datasets')
    && document.getElementById('tabInfo').textContent.includes('Auto: Open Datasets'),
  { timeout: 20_000, polling: 500 },
);
console.log('  ✓ target type auto-selected Open Datasets (no picker interaction)');
await setGroups(['explore', 'create']);
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await sleep(1500);
const inflight = await walksByTab();
const marks = await panel.evaluate(() =>
  [...document.getElementById('targetSelect').options].map((o) => o.textContent));
console.log(`  target marks: ${JSON.stringify(marks)}`);
assert('both walks genuinely in flight at once (neither finished)',
  inflight[tabIds.eb]?.status === 'running' && inflight[tabIds.od]?.status === 'running',
  `eb=${inflight[tabIds.eb]?.status} od=${inflight[tabIds.od]?.status}`);
assert('Target marks both in-flight tabs (running / action needed)',
  marks.some((t) => t.includes('5186') && (t.includes('▶ running') || t.includes('⏸ action needed')))
  && marks.some((t) => t.includes('5187') && t.includes('▶ running')),
  marks.join(' | '));


// --- (b) the panel view swaps whole between the two runs ------------
console.log('== (b) view following swaps the whole panel state ==');
await ebPage.bringToFront();
await panel.waitForFunction(
  () => document.querySelector('#stepList [data-step-id]')?.dataset.stepId === 'first-run',
  { timeout: 20_000, polling: 500 },
);
const ebView = await panel.evaluate(() => ({
  firstStep: document.querySelector('#stepList [data-step-id]')?.dataset.stepId,
  app: document.getElementById('appSelect').value,
  walkApp: window.__tkWalk?.appId,
}));
assert('viewing Email Builder tab shows its run (steps + binding)',
  ebView.firstStep === 'first-run' && ebView.app === 'email-builder' && ebView.walkApp === 'email-builder',
  JSON.stringify(ebView));
await odPage.bringToFront();
await panel.waitForFunction(
  () => document.querySelector('#stepList [data-step-id]')?.dataset.stepId === 'od-explore',
  { timeout: 20_000, polling: 500 },
);
const odView = await panel.evaluate(() => ({
  firstStep: document.querySelector('#stepList [data-step-id]')?.dataset.stepId,
  app: document.getElementById('appSelect').value,
  walkApp: window.__tkWalk?.appId,
}));
assert('viewing Open Datasets tab shows its run (steps + binding)',
  odView.firstStep === 'od-explore' && odView.app === 'open-datasets' && odView.walkApp === 'open-datasets',
  JSON.stringify(odView));
// Release the parked Email Builder run and put Open Datasets back
// in front: EB's remaining step runs hidden (screenshot-less by the
// honest rule), OD's steps keep shooting real PNGs.
await ebPage.bringToFront();
await panel.waitForFunction(
  () => document.getElementById('targetSelect')?.selectedOptions?.[0]?.textContent.includes('localhost:5186'),
  { timeout: 20_000, polling: 500 },
);
await panel.evaluate(() => document.getElementById('btnWalkPause').click());
await odPage.bringToFront();
console.log('  ✓ panel swapped whole between runs; Email Builder resumed hidden, Open Datasets in front');

// --- (c)+(d)+(e) both finish: verdicts, containment, honest shots ---
console.log('== (c) both walks finish, per-tab verdicts ==');
const walks = await waitBothDone();
const ebWalk = walks[tabIds.eb];
const odWalk = walks[tabIds.od];
for (const [label, w] of [['email-builder', ebWalk], ['open-datasets', odWalk]]) {
  for (const r of w?.records ?? []) {
    console.log(`    ${label}/${r.id}: ${r.status}${r.shotMissing ? ' [screenshot unavailable]' : ''}${r.errors.length ? ` errors: ${r.errors.join(' | ')}` : ''}`);
  }
}
const ebIds = (ebWalk?.records ?? []).map((r) => r.id);
const odIds = (odWalk?.records ?? []).map((r) => r.id);
assert('no cross-talk: Email Builder records carry only its step ids',
  ebIds.length > 0 && ebIds.every((id) => !id.startsWith('od-')), ebIds.join(', '));
assert('no cross-talk: Open Datasets records carry only its step ids',
  odIds.length > 0 && odIds.every((id) => id.startsWith('od-')), odIds.join(', '));
const ebById = Object.fromEntries((ebWalk?.records ?? []).map((r) => [r.id, r]));
for (const id of ['first-run', 'seeded-library']) {
  assert(`email-builder ${id} PASS (its single-run verdict)`, ebById[id]?.status === 'pass', ebById[id]?.status ?? '(missing)');
}
const odById = Object.fromEntries((odWalk?.records ?? []).map((r) => [r.id, r]));
for (const id of ['od-explore', 'od-scratch-create', 'od-scratch-edit-contribute']) {
  assert(`open-datasets ${id} PASS (its single-run verdict)`, odById[id]?.status === 'pass', odById[id]?.status ?? '(missing)');
}
assert('neither run saw the other run’s executor (no busy errors)',
  [...(ebWalk?.records ?? []), ...(odWalk?.records ?? [])]
    .every((r) => !r.errors.some((e) => e.includes('executor busy'))));

console.log('== (d) scratch containment per run ==');
assert('email-builder subset was read-only (no scratch created)',
  ebWalk?.scratch == null, JSON.stringify(ebWalk?.scratch ?? null));
assert('open-datasets scratch is this run’s toil-scratch dataset (run-suffixed)',
  /^toil-scratch-\d{8}-\d{6}-/.test(odWalk?.scratch?.name ?? ''), odWalk?.scratch?.name);
assert('open-datasets cleanup deleted its own scratch dataset (while the other run was live)',
  (odWalk?.cleanup?.deleted ?? []).includes(odWalk?.scratch?.name) && (odWalk?.cleanup?.failed ?? []).length === 0,
  JSON.stringify(odWalk?.cleanup));

console.log('== (e) screenshot honesty across visible/hidden tabs ==');
const ebMissing = ebWalk?.missingScreenshots ?? [];
const odMissing = odWalk?.missingScreenshots ?? [];
const ebShot = (ebWalk?.records ?? []).filter((r) => (r.shotBytes ?? 0) > 0).map((r) => r.file);
assert('front tab (Open Datasets): every executed step has a real screenshot',
  odMissing.length === 0 && (odWalk?.records ?? []).every((r) => r.status === 'skipped' || (r.shotBytes ?? 0) > 0),
  `missing: ${odMissing.join(', ') || 'none'}`);
assert('hidden tab (Email Builder): first step shot while visible, later steps honestly missing',
  ebShot.includes('01-first-run.png') && ebMissing.length >= 1,
  `shots: ${ebShot.join(', ')} · missing: ${ebMissing.join(', ')}`);
assert('every hidden-tab record carries the unavailable note and still PASSes (graded from the DOM)',
  (ebWalk?.records ?? []).filter((r) => r.shotMissing)
    .every((r) => r.notes.some((n) => n.startsWith('screenshot unavailable:')) && r.status === 'pass'),
  ebMissing.join(', '));

// Reports + ship manifest name the missing PNGs before the owner
// returns to the hidden tab. Select the Email Builder context in
// the panel while Open Datasets remains the physically visible tab:
// viewing a context alone must not count as returning to its tab.
await panel.evaluate((tabId) => {
  const sel = document.getElementById('targetSelect');
  sel.value = String(tabId);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}, tabIds.eb);
await panel.waitForFunction(
  () => window.__tkWalk?.appId === 'email-builder',
  { timeout: 20_000, polling: 500 },
);
await sleep(750);
const ebBundleBefore = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return b ? { reportMd: b.reportMd, paths: b.files.map((f) => f.path) } : null;
});
assert('email-builder report names the unavailable screenshots (not silently dropped)',
  ebMissing.every((f) => ebBundleBefore?.reportMd.includes(`${f} (unavailable)`) && ebBundleBefore?.reportMd.includes('screenshot unavailable')),
  ebMissing.join(', '));
assert('email-builder bundle ships no PNG it does not have',
  ebMissing.every((f) => !ebBundleBefore?.paths.includes(f)) && ebShot.every((f) => ebBundleBefore?.paths.includes(f)),
  (ebBundleBefore?.paths ?? []).join(', '));
await panel.evaluate(() => {
  window.__tkShipAndReadManifest = async () => {
    window.__tkShipBodies = [];
    window.fetch = async (url, opts) => {
      window.__tkShipBodies.push({ url: String(url), body: opts.body });
      return { ok: true, status: 200, text: async () => '' };
    };
    await chrome.storage.local.set({ tkS3V1: {
      endpoint: 'https://toil-s3.example.invalid', bucket: 'toil-killer-runs',
      accessKey: 'toil-killer-svc', secretKey: 'proof-secret-not-real',
    } });
    await window.__tkWalkReport.shipToHomelab();
    await chrome.storage.local.remove('tkS3V1');
    const manifestCall = window.__tkShipBodies.find((c) => c.url.endsWith('/ship-manifest.json'));
    return manifestCall ? JSON.parse(new TextDecoder().decode(manifestCall.body)) : null;
  };
});
const manifestProbe = await panel.evaluate(() => window.__tkShipAndReadManifest());
assert('ship manifest lists missingScreenshots for the hidden-tab run',
  JSON.stringify(manifestProbe?.missingScreenshots ?? []) === JSON.stringify(ebMissing),
  JSON.stringify(manifestProbe?.missingScreenshots ?? null));

console.log('== (g) returning to the tab retakes missing screenshots ==');
const ebStatusesBefore = Object.fromEntries((ebWalk?.records ?? []).map((r) => [r.id, r.status]));
await ebPage.bringToFront();
await panel.waitForFunction(
  (tabId, files) => {
    const walk = window.__tkWalkReport.walksByTab()[tabId];
    return files.length > 0 && files.every((file) => {
      const record = walk?.records.find((r) => r.file === file);
      return Boolean(record?.shotRetakenAt && (record?.shotBytes ?? 0) > 0);
    });
  },
  { timeout: 30_000, polling: 500 },
  tabIds.eb,
  ebMissing,
);
const walksAfterRetake = await walksByTab();
const ebAfterRetake = walksAfterRetake[tabIds.eb];
assert('returning to the hidden tab automatically retakes every missing screenshot',
  ebMissing.every((file) => {
    const record = ebAfterRetake?.records.find((r) => r.file === file);
    return Boolean(record?.shotRetakenAt && (record?.shotBytes ?? 0) > 0);
  }),
  JSON.stringify(ebAfterRetake?.records.filter((r) => ebMissing.includes(r.file))));
assert('retaken screenshots leave missingScreenshots bookkeeping',
  (ebAfterRetake?.missingScreenshots ?? []).length === 0,
  JSON.stringify(ebAfterRetake?.missingScreenshots ?? null));
assert('screenshot retakes never change step grades',
  (ebAfterRetake?.records ?? []).every((r) => ebStatusesBefore[r.id] === r.status),
  JSON.stringify(ebAfterRetake?.records.map((r) => [r.id, r.status])));
assert('retaken records label the current-view evidence and unchanged grade',
  ebMissing.every((file) => {
    const record = ebAfterRetake?.records.find((r) => r.file === file);
    return record?.notes.some((n) => n.includes('screenshot retaken on return to the tab at') && n.includes('graded status above is unchanged'));
  }),
  ebMissing.join(', '));
const retakeStatus = await panel.evaluate(() => document.getElementById('shipStatus').textContent);
assert('retakes after Ship are marked local until re-ship',
  retakeStatus.includes('retaken on return') && retakeStatus.includes('local until re-ship'),
  retakeStatus);
const ebBundle = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return b ? {
    reportMd: b.reportMd,
    paths: b.files.map((f) => f.path),
    retakenAt: Object.fromEntries(b.files.filter((f) => f.retakenAt).map((f) => [f.path, f.retakenAt])),
  } : null;
});
assert('regenerated report labels retaken screenshots with their retake time',
  ebMissing.every((file) => ebBundle?.reportMd.includes(`${file}`) && ebBundle?.reportMd.includes('retaken on return to the tab at')),
  ebBundle?.reportMd.match(/retaken on return to the tab at [^\n)]+/)?.[0] ?? '(none)');
assert('regenerated bundle includes the retaken PNGs',
  ebMissing.every((file) => ebBundle?.paths.includes(file)),
  (ebBundle?.paths ?? []).join(', '));
const manifestAfterRetake = await panel.evaluate(() => window.__tkShipAndReadManifest());
assert('re-shipped manifest moves retaken files out of missingScreenshots',
  JSON.stringify(manifestAfterRetake?.missingScreenshots ?? null) === '[]',
  JSON.stringify(manifestAfterRetake?.missingScreenshots ?? null));
assert('re-shipped manifest records retakenAt on each retaken file',
  ebMissing.every((file) => {
    const entry = manifestAfterRetake?.files.find((f) => f.path === file);
    return Boolean(entry?.retakenAt) && entry.retakenAt === ebBundle?.retakenAt[file];
  }),
  JSON.stringify(manifestAfterRetake?.files.filter((f) => ebMissing.includes(f.path))));
const retakenAtBeforeSecondReturn = Object.fromEntries(
  (ebAfterRetake?.records ?? []).filter((r) => ebMissing.includes(r.file)).map((r) => [r.file, r.shotRetakenAt]),
);
await odPage.bringToFront();
await panel.waitForFunction(
  () => window.__tkWalk?.appId === 'open-datasets',
  { timeout: 20_000, polling: 500 },
);
await ebPage.bringToFront();
await panel.waitForFunction(
  () => window.__tkWalk?.appId === 'email-builder',
  { timeout: 20_000, polling: 500 },
);
await sleep(1500);
const walksAfterSecondReturn = await walksByTab();
const retakenAtAfterSecondReturn = Object.fromEntries(
  (walksAfterSecondReturn[tabIds.eb]?.records ?? []).filter((r) => ebMissing.includes(r.file)).map((r) => [r.file, r.shotRetakenAt]),
);
assert('a second return does not shoot the retaken screenshots again',
  JSON.stringify(retakenAtAfterSecondReturn) === JSON.stringify(retakenAtBeforeSecondReturn),
  JSON.stringify(retakenAtAfterSecondReturn));

// Ship pointer (v0.7.3): visible on the tab that shipped, hidden on
// the other tab, restored on return — and copies exactly the ID.
const ebPointer = await panel.evaluate(() => ({
  hidden: document.getElementById('shipRunRow').hidden,
  id: document.getElementById('shipRunId').textContent,
}));
assert('ship pointer shows the shipped run ID on the shipping tab',
  !ebPointer.hidden && /^walk-email-builder-\d{4}-\d{2}-\d{2}-\d{4}(-\d{2})?$/.test(ebPointer.id), ebPointer.id);
await odPage.bringToFront();
await panel.waitForFunction(
  () => window.__tkWalk?.appId === 'open-datasets',
  { timeout: 20_000, polling: 500 },
);
const odPointer = await panel.evaluate(() => document.getElementById('shipRunRow').hidden);
assert('ship pointer hides on a tab that has not shipped', odPointer === true, `hidden=${odPointer}`);
await ebPage.bringToFront();
await panel.waitForFunction(
  () => window.__tkWalk?.appId === 'email-builder',
  { timeout: 20_000, polling: 500 },
);
const backPointer = await panel.evaluate(async () => {
  window.__tkCopied = null;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__tkCopied = t; } },
    });
  } catch { /* selection fallback still leaves the ID visible */ }
  document.getElementById('btnCopyRunId').click();
  await new Promise((r) => setTimeout(r, 100));
  return {
    hidden: document.getElementById('shipRunRow').hidden,
    id: document.getElementById('shipRunId').textContent,
    copied: window.__tkCopied,
  };
});
assert('ship pointer is restored when returning to the shipping tab',
  !backPointer.hidden && backPointer.id === ebPointer.id, backPointer.id);
assert('copy button writes exactly the run ID', backPointer.copied === ebPointer.id, backPointer.copied ?? '(no clipboard copy)');

console.log('== (f) auto target type: a no-app tab cannot start a run ==');
const blankPage = await browser.newPage();
await blankPage.goto('about:blank', { waitUntil: 'load', timeout: 30_000 });
await blankPage.bringToFront();
await panel.waitForFunction(
  () => document.getElementById('catalogLine').textContent.includes('No app in this tab')
    && document.getElementById('tabInfo').textContent.includes('No app in this tab'),
  { timeout: 20_000, polling: 500 },
);
const noApp = await panel.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const blank = tabs.find((t) => t.url === 'about:blank');
  return {
    tabId: blank?.id,
    app: document.getElementById('appSelect').value,
    appIndex: document.getElementById('appSelect').selectedIndex,
    runDisabled: document.getElementById('btnWalkRun').disabled,
    groups: document.querySelectorAll('#groupList input[type="checkbox"]').length,
    ctx: blank?.id != null ? window.__tkWalkReport.contextsByTab()[blank.id] : null,
  };
});
assert('no-app tab leaves the target type unselected and Run disabled',
  noApp.app === '' && noApp.appIndex === -1 && noApp.runDisabled && noApp.groups === 0,
  JSON.stringify(noApp));
assert('no-app tab context records no detected or bound app',
  noApp.ctx?.detectedAppId == null && noApp.ctx?.bindingAppId == null,
  JSON.stringify(noApp.ctx));
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await sleep(500);
const noAppWalks = await walksByTab();
assert('clicking the disabled Run starts nothing on the no-app tab',
  noApp.tabId == null || noAppWalks[noApp.tabId] == null,
  JSON.stringify(noAppWalks[noApp.tabId] ?? null));
await blankPage.close();

const marksDone = await panel.evaluate(() =>
  [...document.getElementById('targetSelect').options].map((o) => o.textContent));
assert('Target marks both tabs done at the end',
  marksDone.some((t) => t.includes('5186') && t.includes('✓ done'))
  && marksDone.some((t) => t.includes('5187') && t.includes('✓ done')),
  marksDone.join(' | '));

await browser.close();
for (const proc of booted) {
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
}
console.log(failures === 0 ? '\nCONCURRENCY PROOF OK — all assertions green' : `\nCONCURRENCY PROOF FAILED — ${failures} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
