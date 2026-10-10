// Toil-Killer headless proof (mock harness only — no live origin, no
// Buzz). Sections (a)–(e2) prove §8.3–5; (f)–(i) prove §8.6–7:
//
//   (a) extension loads; the panel's displayed catalog hash matches
//       tools/walk/steps.json (and `npm run steps:check` passes);
//   (b) through the REAL panel UI: first-run group passes with its 4
//       data checks, seeded-library (multi-check code step) passes,
//       and the walls steps report skip-live with reasons, not run;
//   (c) the bundle group halts in AWAITING-USER at the price-confirm
//       card — eb-confirm still open, eb-confirm-run never clicked —
//       and ends the run there on "End run here";
//   (d) the spike injection probe still passes (diagnostics intact);
//   (e1/e2) the §8.5 report writer (bundle contents, taste strip,
//       halted-run honesty);
//   (f) §8.6 full-catalog run with the proof playing the user (the
//       PROOF clicks Send / price confirms in the page — the user
//       role; the runner never does): bundle-outcome and
//       banner-generated PASS behind the gate, the broken-banner trio
//       is detection-driven, scratch steps run on a walk-scratch draft;
//   (g) scratch containment: library names identical before/after and
//       run-end cleanup recorded;
//   (h) §8.7 scratch toggle OFF (persisted): stateful steps skip and
//       nothing is created;
//   (i) §8.6 consent wall on ?consent=ungrantable: the acted step ends
//       live-limited: consent with the verbatim notice; run stops
//       cleanly;
//   (j) §8.8 live-branch calibration with the proof override ON: the
//       full catalog passes account-shaped on the same harness
//       (seed names read as data, never asserted);
//   (j2) §8.8 no qualifying draft: on a fresh unseeded visit the
//       preview chain reports one live-limited reason and the run
//       CONTINUES into a later group.
//   (a2) v0.2.2 version handshake: the ping payload and every step
//       record carry the executor build (== manifest version, read
//       at runtime) and the panel contains the pre-run gate. The
//       stale-frame case itself needs an old build in the tab —
//       asserted present, not rehearsed.
//   (k) v0.2.3 watchdog: the execution fuse burns execution time
//       only. Driven behaviorally through the localhost dev hook:
//       the real watchdog accounting runs against a never-settling
//       handler with a 1.5s fuse while a §5-style user park
//       (walkCtl.awaiting) is held for 2.5s — it must stay silent
//       through the park and fire once execution resumes. The 150s
//       production fuse is the same accounting; it is not waited
//       out in real time.
//   (l1) v0.2.4 dispatch liveness: the panel's dispatch deadline is
//       progress-aware — parked steps have NO deadline, otherwise
//       180s of silence. Driven behaviorally on the real panel page
//       through window.watchDispatchLiveness with stub sources and
//       a 1s fuse (the production function, budget shortened).
//   (l2) v0.2.4 auto-resume: with the live override ON, the proof
//       (user role) clicks ONLY eb-send in the page — never the
//       panel's Resume — and the interview step must resume on its
//       own (act observed in the page) and reach the live post-send
//       grading. On this harness the mock host returns no text, so
//       the app answers with its honest no-reply note and the step
//       ends live-limited with the note verbatim (settlement: a
//       real reply cannot be manufactured here — the same class as
//       §8.6's dead-banner settlement; (j)'s live counts move to
//       15·0·3·4 for exactly this one step).
//   (l3) v0.2.4 Stop during a park: Stop ends the parked dispatch
//       promptly — the executor's record returns (ended at the
//       user-action point), never a liveness timeout.
//
// Run:  node tools/walk-extension/proof/proof-runner.mjs
// Boots the mock harness itself if nothing is serving :5186.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

// --- harness lifecycle (mirrors run.mjs: reuse if already serving) ---
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
    cwd: APP_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 120; i++) {
    if (await serverUp()) return true;
    if (serverProc.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error('dev:harness did not come up');
}

// --- (a) catalog integrity before the browser even opens ------------
console.log('== (a) catalog sync + panel hash ==');
execFileSync('npm', ['run', 'steps:check'], { cwd: APP_DIR, stdio: 'pipe' });
console.log('  ✓ npm run steps:check exits 0');
const expectedHash = createHash('sha256')
  .update(fs.readFileSync(path.join(APP_DIR, 'tools', 'walk', 'steps.json')))
  .digest('hex');
console.log(`  source steps.json sha256: ${expectedHash.slice(0, 16)}…`);

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
console.log(`  extension service worker: ${sw.url()}`);

// harness tab first, so the panel's target discovery can find it
const harness = await browser.newPage();
// Mirror run.mjs's request policy: the mock's canned banner URL is an
// external placeholder (placehold.co) that this sandbox cannot fetch;
// the mock walk intercepts it and serves a local stand-in, and the
// extension proof must do the same or generated banners "break" for
// network reasons that have nothing to do with the app or the runner.
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
await harness.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
await sleep(3000);

const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'load', timeout: 30_000 });

// catalog line: version, hash, sync verdict, extension version
const catalogText = await panel.waitForFunction(
  () => {
    const el = document.getElementById('catalogLine');
    return el && el.textContent.includes('sha256') ? el.textContent : null;
  },
  { timeout: 20_000 },
).then((h) => h.jsonValue());
console.log(`  panel catalog line: ${catalogText}`);
assert('panel catalog hash matches tools/walk/steps.json', catalogText.includes(`sha256 ${expectedHash.slice(0, 12)}`));
assert('panel reports copy in sync', catalogText.includes('✓ sync'));
assert('panel shows extension v0.7.10', catalogText.includes('extension v0.7.10'));
assert('panel shows 22 steps', catalogText.includes('22 steps'));

// target auto-discovery: the harness tab, eb-app seen
await panel.waitForFunction(
  () => {
    const sel = document.getElementById('targetSelect');
    const opt = sel?.selectedOptions?.[0];
    return opt && opt.textContent.includes('eb-app') && opt.textContent.includes('localhost:5186');
  },
  { timeout: 25_000 },
).catch(async () => {
  await panel.evaluate(() => document.getElementById('btnTargets').click());
  await panel.waitForFunction(
    () => {
      const opt = document.getElementById('targetSelect')?.selectedOptions?.[0];
      return opt && opt.textContent.includes('eb-app') && opt.textContent.includes('localhost:5186');
    },
    { timeout: 25_000 },
  );
});
console.log('  ✓ panel auto-selected the harness tab (eb-app frame)');
const ebAutoPick = await panel.evaluate(() => ({
  app: document.getElementById('appSelect').value,
  info: document.getElementById('tabInfo').textContent,
}));
assert('panel auto-selected the Email Builder target type from the tab',
  ebAutoPick.app === 'email-builder' && ebAutoPick.info.includes('Auto: Email Builder'),
  JSON.stringify(ebAutoPick));

// seeded URL for mock rehearsal visits
await panel.evaluate((url) => {
  document.getElementById('seededUrl').value = url;
}, seededUrl(BASE));

// --- (a2) v0.2.2 version handshake: payloads + gate presence -------
// The stale-frame failure (an un-reloaded tab holding a pre-reload
// content script) cannot be reproduced headlessly without an old
// build — what is proven here is the mechanism the gate relies on:
// the frame stamps its runtime-read build on the ping payload, and
// the panel source contains the pre-run gate + mid-step hint.
console.log('== (a2) v0.2.2 version handshake payloads ==');
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'),
).version;
assert('extension manifest bumped to 0.7.10', manifestVersion === '0.7.10', manifestVersion);
const pingEvidence = await harness.evaluate(async () => {
  document.dispatchEvent(new CustomEvent('tk-spike-dev', { detail: { action: 'inject' } }));
  for (let i = 0; i < 50; i++) {
    const node = document.getElementById('tk-spike-result');
    if (node?.textContent) {
      const parsed = JSON.parse(node.textContent);
      node.textContent = '';
      return parsed;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
});
assert('inject probe (ping) payload carries executorVersion == manifest version',
  pingEvidence?.executorVersion === manifestVersion,
  `frame: ${pingEvidence?.executorVersion ?? '(none)'} · manifest: ${manifestVersion}`);
const panelSrc = fs.readFileSync(path.join(EXT_DIR, 'panel.js'), 'utf8');
assert('panel contains the pre-run version handshake (checkExecutorVersion gate)',
  panelSrc.includes('checkExecutorVersion'), 'gate function present in panel.js');
// v0.2.4: the wall-clock dispatch race is gone — the deadline is
// now the progress-aware liveness clock (parked → no deadline;
// otherwise 180s of silence). Assert the mechanism + truthful
// wording replaced it, and the stale-script hint survived.
assert('panel contains the mid-step stale-script hint; dispatch race is now progress-aware (v0.2.4)',
  panelSrc.includes('stale in-page script') && panelSrc.includes('watchDispatchLiveness')
  && panelSrc.includes('not parked awaiting you') && !panelSrc.includes('did not respond within 180s'), '');

// --- (k) v0.2.3 watchdog: a §5 user park doesn't burn the fuse -----
// Behavioral, with a short fuse: the localhost dev hook drives the
// REAL watchdog accounting (watchStepExecution) in the page against
// a never-settling handler, with walkCtl.awaiting held across a 1.5s
// budget (the same flag H.awaitUser sets). The park (2.5s) outlasts
// the fuse; the watchdog must stay silent while parked and fire once
// execution resumes. What this does not do: wait out the real 150s
// fuse — it is the same accounting with budgetMs shortened.
console.log('== (k) v0.2.3 watchdog: user parks excluded from the execution fuse ==');
const wdResult = await harness.evaluate(async () => {
  document.dispatchEvent(new CustomEvent('tk-watchdog-dev', { detail: { budgetMs: 1500, parkMs: 2500 } }));
  for (let i = 0; i < 60; i++) {
    const node = document.getElementById('tk-watchdog-result');
    if (node?.textContent) {
      const parsed = JSON.parse(node.textContent);
      node.textContent = '';
      return parsed;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
});
assert('watchdog stayed silent while parked past the fuse (park 2.5s > budget 1.5s)',
  wdResult?.firedDuringPark === false, JSON.stringify(wdResult));
assert('watchdog fired after the park ended (a runaway still fails)',
  wdResult?.firedAtMs !== null && wdResult?.firedAtMs > wdResult?.parkMs,
  wdResult ? `fired at ${wdResult.firedAtMs}ms` : 'no result');
assert('watchdog fired promptly once execution resumed (within budget + tick slack)',
  wdResult?.firedAtMs !== null && wdResult.firedAtMs <= wdResult.parkMs + wdResult.budgetMs + 3000,
  wdResult ? `${wdResult.firedAtMs}ms` : 'no result');
assert('watchdog error wording is truthful (execution time; user halts don’t count)',
  (wdResult?.error ?? '').includes('1.5s watchdog') && (wdResult?.error ?? '').includes('user halts don’t count'),
  wdResult?.error ?? '(none)');

// --- (l1) v0.2.4 dispatch liveness: parked → no deadline ---------
// The PRODUCTION accounting (panel's watchDispatchLiveness) driven
// on the real panel page with stub sources and a 1s fuse: parked
// silence must never fire; unparked silence must fire; flowing
// progress must keep resetting the clock. The 180s production
// budget is the same function with budgetMs lengthened.
console.log('== (l1) v0.2.4 dispatch liveness: park has no deadline, silence does ==');
const live1 = await panel.evaluate(async () => {
  const sleepP = (ms) => new Promise((r) => setTimeout(r, ms));
  // parked the whole time: must stay silent well past the fuse
  let firedWhileParked = false;
  const t0 = Date.now();
  const parkedWatch = window.watchDispatchLiveness({
    isSettled: () => false, isParked: () => true, progressCount: () => 0, budgetMs: 1000,
  }).then(() => { firedWhileParked = true; });
  await sleepP(2200);
  const silentWhileParked = !firedWhileParked;
  void parkedWatch;
  // unpark into silence: must fire ~one budget later
  let parked = true;
  let firedAtMs = null;
  const silWatch = window.watchDispatchLiveness({
    isSettled: () => false, isParked: () => parked, progressCount: () => 0, budgetMs: 1000,
  }).then((r) => { if (r?.timeout) firedAtMs = Date.now() - t0; });
  await sleepP(1200);
  const stillSilentParked = firedAtMs === null;
  parked = false;
  await Promise.race([silWatch, sleepP(4000)]);
  // progress flowing: counter keeps moving, must not fire; then stops
  let count = 0;
  let flowFiredAt = null;
  const t1 = Date.now();
  const flowWatch = window.watchDispatchLiveness({
    isSettled: () => false, isParked: () => false, progressCount: () => count, budgetMs: 1000,
  }).then((r) => { if (r?.timeout) flowFiredAt = Date.now() - t1; });
  const iv = setInterval(() => { count += 1; }, 300);
  await sleepP(2400);
  const silentWhileFlowing = flowFiredAt === null;
  clearInterval(iv);
  await Promise.race([flowWatch, sleepP(4000)]);
  return {
    silentWhileParked, stillSilentParked,
    firedAfterUnparkMs: firedAtMs === null ? null : firedAtMs - 1200,
    silentWhileFlowing, flowFiredAfterStopMs: flowFiredAt,
  };
});
assert('dispatch liveness stays silent while parked past the fuse (park 2.2s > budget 1s)',
  live1.silentWhileParked && live1.stillSilentParked, JSON.stringify(live1));
assert('dispatch liveness fires once unparked into silence (within budget + slack)',
  live1.firedAfterUnparkMs !== null && live1.firedAfterUnparkMs >= 800 && live1.firedAfterUnparkMs <= 3500,
  live1.firedAfterUnparkMs === null ? 'never fired' : `${live1.firedAfterUnparkMs}ms after unpark`);
assert('flowing progress keeps the dispatch alive; silence after flow times out',
  live1.silentWhileFlowing && live1.flowFiredAfterStopMs !== null && live1.flowFiredAfterStopMs > 2400,
  JSON.stringify(live1));

async function setGroups(wanted) {
  await panel.evaluate((groups) => {
    for (const box of document.querySelectorAll('#groupList input[type="checkbox"]')) {
      const want = groups.includes(box.dataset.group);
      if (box.checked !== want) box.click();
    }
  }, wanted);
}

async function walkRecords() {
  return panel.evaluate(() => {
    const w = window.__tkWalk;
    if (!w) return null;
    return {
      status: w.status,
      records: w.records.map((r) => ({
        id: r.id, file: r.file, status: r.status, checks: r.checks,
        notes: r.notes, errors: r.errors,
        confirmLeftOpen: r.confirmLeftOpen,
      })),
    };
  });
}

async function waitWalkDone(timeoutMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const w = await walkRecords();
    if (w?.status === 'done') return w;
    if (Date.now() - t0 > timeoutMs) throw new Error(`walk did not finish within ${timeoutMs}ms`);
    await sleep(1000);
  }
}

// --- (b) first-run + library + walls through the real panel ---------
console.log('== (b) panel run: first-run + library + walls (mock harness) ==');
await setGroups(['first-run', 'library', 'walls']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const run1 = await waitWalkDone();
for (const r of run1.records) {
  console.log(`  ${r.id}: ${r.status} [${r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`).join(' · ')}]`);
  for (const n of r.notes) console.log(`      — ${n}`);
  for (const e of r.errors) console.log(`      ! ${e}`);
}
const firstRun = run1.records.find((r) => r.id === 'first-run');
assert('first-run PASS', firstRun?.status === 'pass');
assert('first-run 4/4 data checks pass', firstRun?.checks.length === 4 && firstRun.checks.every((c) => c.ok),
  firstRun ? `${firstRun.checks.filter((c) => c.ok).length}/${firstRun.checks.length}` : 'missing');
const seededLib = run1.records.find((r) => r.id === 'seeded-library');
assert('seeded-library (multi-check code step) PASS', seededLib?.status === 'pass',
  seededLib ? `${seededLib.checks.filter((c) => c.ok).length}/${seededLib.checks.length} checks` : 'missing');
for (const wallId of ['wall-guest', 'wall-consent', 'wall-insufficient']) {
  const wall = run1.records.find((r) => r.id === wallId);
  assert(`${wallId} reported skipped (skip-live, not run)`,
    wall?.status === 'skipped' && wall.notes.some((n) => n.startsWith('skip-live:')),
    wall ? wall.notes[0] : 'missing');
}
const recordVersions = await panel.evaluate(() =>
  (window.__tkWalk?.records ?? []).map((r) => r.executorVersion ?? null));
assert('every step record carries executorVersion == manifest version (v0.2.4)',
  recordVersions.length === run1.records.length && recordVersions.length > 0
  && recordVersions.every((v) => v === manifestVersion),
  JSON.stringify(recordVersions));

// --- (e1) report writer (§8.5): bundle contents of the run above ---
console.log('== (e1) walk report writer: bundle contents (first-run + library + walls run) ==');
const bundle1 = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return {
    paths: b.files.map((f) => f.path),
    reportMd: b.reportMd, stripHtml: b.stripHtml, tasteHtml: b.tasteHtml, diffs: b.diffs,
  };
});
const executedFiles1 = run1.records
  .filter((r) => !['skipped', 'live-limited'].includes(r.status))
  .map((r) => r.file)
  .sort();
assert('bundle PNG names == catalog files of executed steps',
  JSON.stringify(bundle1.paths.filter((p) => p.endsWith('.png')).sort()) === JSON.stringify(executedFiles1),
  executedFiles1.join(', '));
assert('bundle has the three text artifacts',
  ['report.md', 'strip.html', 'taste-strip.html'].every((p) => bundle1.paths.includes(p)),
  bundle1.paths.join(', '));
const stripSrcs1 = [...bundle1.stripHtml.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]).sort();
assert('strip.html references exactly the executed-step PNGs',
  JSON.stringify(stripSrcs1) === JSON.stringify(executedFiles1), stripSrcs1.join(', '));
const sumLine1 = bundle1.reportMd.split('\n').find((l) => l.startsWith('**Summary:**')) ?? '';
const expectedCounts1 = [
  `${run1.records.filter((r) => r.status === 'pass').length} passed`,
  `${run1.records.filter((r) => r.status === 'fail').length} failed`,
  `${run1.records.filter((r) => r.status === 'skipped').length} skipped`,
  `${run1.records.filter((r) => r.status === 'live-limited').length} live-limited`,
];
assert('report summary counts match the run', expectedCounts1.every((s) => sumLine1.includes(s)), sumLine1);
assert('report carries catalog version + sha256',
  bundle1.reportMd.includes('Step catalog email-builder v1') && bundle1.reportMd.includes(`sha256 ${expectedHash.slice(0, 16)}`));
assert('report carries the §5 safety line',
  bundle1.reportMd.includes("Send/confirm never clicked by the runner; spends only via the user"));
assert('report uses live labels (PASS/SKIPPED), never mock ones',
  bundle1.reportMd.includes('first-run — PASS') && !bundle1.reportMd.includes('MOCK-LIMITED'));
assert('skipped step gets its reason blockquote and no screenshot link',
  bundle1.reportMd.includes('> Skipped: skip-live:') && !bundle1.reportMd.includes('[20-wall-guest.png](20-wall-guest.png)'));
assert('executed step gets its screenshot link',
  bundle1.reportMd.includes('[01-first-run.png](01-first-run.png)'));
console.log(`  summary line: ${sumLine1}`);
console.log('\n----- sample report.md (proof run: first-run + library + walls) -----');
console.log(bundle1.reportMd);
console.log('----- end sample report.md -----\n');

// taste strip with no baseline, then identical, then doctored
assert('no baseline yet → taste strip says so, no diffs claimed',
  bundle1.diffs === null && bundle1.tasteHtml.includes('no baseline imported')
  && bundle1.reportMd.includes('No baseline imported'));
await panel.evaluate((file) => {
  window.__tkWalkReport.setBaseline({ [file]: window.__tkWalk.shots[file] });
}, '01-first-run.png');
const bundleSame = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return { diffs: b.diffs, tasteHtml: b.tasteHtml, paths: b.files.map((f) => f.path) };
});
const sameDiff = bundleSame.diffs?.find((d) => d.file === '01-first-run.png');
assert('identical baseline screenshot → unchanged, 0%',
  sameDiff?.state === 'unchanged' && sameDiff.pct === 0, JSON.stringify(sameDiff));
assert('taste strip shows unchanged (no CHANGED flag)',
  bundleSame.tasteHtml.includes('unchanged') && !bundleSame.tasteHtml.includes('CHANGED'));
assert('baseline copy rides along under baseline/',
  bundleSame.paths.includes('baseline/01-first-run.png'));
await panel.evaluate(async (file) => {
  const src = window.__tkWalk.shots[file];
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, c.width, Math.ceil(c.height * 0.6));
  window.__tkWalkReport.setBaseline({ [file]: c.toDataURL('image/png') });
}, '01-first-run.png');
const bundleDoctored = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return { diffs: b.diffs, tasteHtml: b.tasteHtml, paths: b.files.map((f) => f.path), reportMd: b.reportMd };
});
const docDiff = bundleDoctored.diffs?.find((d) => d.file === '01-first-run.png');
assert('doctored baseline screenshot → CHANGED over the 2% triage threshold',
  docDiff?.state === 'changed' && docDiff.pct > 2, JSON.stringify(docDiff));
assert('taste strip shows the CHANGED flag',
  bundleDoctored.tasteHtml.includes('CHANGED'));

// real downloads through chrome.downloads (the bundle incl. baseline copies)
const dl = await panel.evaluate(async () => {
  const ids = await window.__tkWalkReport.downloadBundle();
  const states = {};
  for (let i = 0; i < 40; i++) {
    let pending = false;
    for (const id of ids) {
      const rows = await chrome.downloads.search({ id });
      states[id] = rows[0]?.state ?? 'unknown';
      if (states[id] === 'in_progress') pending = true;
    }
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { count: ids.length, states, line: document.getElementById('bundleStatus').textContent };
});
console.log(`  downloads: ${dl.count} items accepted — final states: ${JSON.stringify(dl.states)}`);
console.log(`  bundle status line: ${dl.line}`);
assert('chrome.downloads accepted every bundle file',
  dl.count === bundleDoctored.paths.length && Object.keys(dl.states).length === dl.count,
  `${dl.count} downloads`);
const dlStates = Object.values(dl.states);
console.log(dlStates.every((s) => s === 'complete')
  ? '  downloads completed headlessly ✓'
  : '  NOTE: downloads did not all complete headlessly (states above) — generated file CONTENTS are the asserted substrate; the on-disk path is exercised by the same downloadBundle() code Zacx clicks.');
const baselineIds = await panel.evaluate(async () => window.__tkWalkReport.saveBaseline());
assert('save-as-baseline downloads PNGs + manifest', baselineIds.length === 3, `${baselineIds.length} files`);

// ship-to-homelab: bundle + ship-manifest.json, no token in the panel
const ship = await panel.evaluate(async () => {
  const ids = await window.__tkWalkReport.shipToHomelab();
  return { count: ids.length, line: document.getElementById('shipStatus').textContent };
});
assert('ship downloads bundle + ship-manifest.json', ship.count === dl.count + 1, `${ship.count} files`);
assert('ship status names the Downloads handoff', ship.line.includes('Downloads/'), ship.line);
assert('ship fallback names the Downloads path when no S3 secret is saved',
  panelSrc.includes('Downloads fallback (no S3 secret saved)'), 'fallback in panel.js');

// Ship pointer (v0.7.3): the fallback Ship surfaces the run ID with
// a copy button; the button copies exactly that ID.
const shipPointer = await panel.evaluate(async () => {
  window.__tkCopied = null;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__tkCopied = t; } },
    });
  } catch { /* the click below still exercises the selection fallback */ }
  const row = document.getElementById('shipRunRow');
  const id = document.getElementById('shipRunId').textContent;
  document.getElementById('btnCopyRunId').click();
  await new Promise((r) => setTimeout(r, 100));
  return { hidden: row.hidden, id, copied: window.__tkCopied, glyph: document.getElementById('btnCopyRunId').textContent };
});
assert('ship pointer row shows after the Downloads-fallback Ship', !shipPointer.hidden, `hidden=${shipPointer.hidden}`);
assert('ship pointer shows the run ID (bundle folder leaf)',
  /^walk-email-builder-\d{4}-\d{2}-\d{2}-\d{4}(-\d{2})?$/.test(shipPointer.id), shipPointer.id);
assert('copy button writes exactly the run ID to the clipboard',
  shipPointer.copied === shipPointer.id, shipPointer.copied ?? '(no clipboard copy)');
assert('copy button confirms with a check glyph', shipPointer.glyph === '✓', shipPointer.glyph);

// S3 direct ship: stub fetch in the panel, save a test credential in
// chrome.storage.local, and verify SigV4 PUTs — right count, right
// keys, manifest LAST, base64 checksum of the raw digest, no secret
// leaked into any request or into panel.js source.
const s3ship = await panel.evaluate(async () => {
  window.__tkS3Calls = [];
  window.fetch = async (url, opts) => {
    window.__tkS3Calls.push({ url: String(url), method: opts.method, headers: opts.headers, bytes: opts.body?.byteLength ?? 0 });
    return { ok: true, status: 200, text: async () => '' };
  };
  await chrome.storage.local.set({ tkS3V1: {
    endpoint: 'https://toil-s3.example.invalid', bucket: 'toil-killer-runs',
    accessKey: 'toil-killer-svc', secretKey: 'proof-secret-not-real',
  } });
  const keys = await window.__tkWalkReport.shipToHomelab();
  const line = document.getElementById('shipStatus').textContent;
  await chrome.storage.local.remove('tkS3V1');
  return { keys, line, calls: window.__tkS3Calls };
});
assert('S3 ship PUTs every file + manifest', s3ship.keys.length === dl.count + 1, `${s3ship.keys.length} keys`);
assert('S3 manifest goes last (its hashes vouch for the rest)',
  s3ship.keys[s3ship.keys.length - 1].endsWith('/ship-manifest.json'), s3ship.keys.at(-1));
assert('S3 ship status names the bucket/prefix', s3ship.line.includes('S3 ✓ toil-killer-runs/'), s3ship.line);
assert('S3 requests are SigV4 PUTs with checksum headers, secret never in a header',
  s3ship.calls.every((c) => c.method === 'PUT'
    && (c.headers.Authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=toil-killer-svc/')
    && typeof c.headers['x-amz-checksum-sha256'] === 'string'
    && !JSON.stringify(c.headers).includes('proof-secret-not-real')),
  JSON.stringify(s3ship.calls[0]?.headers ?? {}).slice(0, 160));
const s3Pointer = await panel.evaluate(() => ({
  hidden: document.getElementById('shipRunRow').hidden,
  id: document.getElementById('shipRunId').textContent,
}));
const s3RunId = s3ship.keys[0].split('/').filter(Boolean).at(-2);
assert('S3 Ship surfaces the same run ID pointer', !s3Pointer.hidden && s3Pointer.id === s3RunId,
  `${s3Pointer.id} vs ${s3RunId}`);

// --- (c) bundle group: halt at the price-confirm, never click -------
console.log('== (c) panel run: bundle group halts at the price-confirm ==');
await setGroups(['bundle']);
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const clearedPointer = await panel.evaluate(() => ({
  hidden: document.getElementById('shipRunRow').hidden,
  shipped: Object.values(window.__tkWalkReport.contextsByTab()).map((c) => c.shippedRunId),
}));
assert('starting a new run clears the previous Ship pointer',
  clearedPointer.hidden && clearedPointer.shipped.every((s) => s == null),
  JSON.stringify(clearedPointer));
// NOTE: polling must be interval-based, not the default 'raf' — the
// harness tab is in front, so this panel page is backgrounded and its
// requestAnimationFrame never fires.
try {
  await panel.waitForFunction(
    () => !document.getElementById('awaitBanner').hidden,
    { timeout: 120_000, polling: 500 },
  );
} catch (err) {
  const dump = await walkRecords().catch(() => null);
  console.log('  banner never appeared; walk state at timeout:', JSON.stringify(dump));
  throw err;
}
const bannerText = await panel.evaluate(() => document.getElementById('awaitText').textContent);
console.log(`  banner: ${bannerText}`);
assert('run halts in AWAITING-USER at the price-confirm card', bannerText.includes('price-confirm'));
const confirmState = await harness.evaluate(() => ({
  cardOpen: document.querySelector('[data-testid="eb-confirm"]') !== null,
  confirmButtonPresent: document.querySelector('[data-testid="eb-confirm-run"]') !== null,
  draftWidgetYet: document.querySelector('[data-testid="eb-draft-widget"]') !== null,
}));
console.log(`  page state at halt: ${JSON.stringify(confirmState)}`);
assert('eb-confirm card still open in the page (not clicked)', confirmState.cardOpen && confirmState.confirmButtonPresent);
assert('no package materialized (the spend never happened)', !confirmState.draftWidgetYet);
await panel.evaluate(() => document.getElementById('btnUserEnd').click());
const run2 = await waitWalkDone(120_000);
for (const r of run2.records) {
  console.log(`  ${r.id}: ${r.status}${r.confirmLeftOpen ? ' [confirmLeftOpen]' : ''} [${r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`).join(' · ')}]`);
  for (const n of r.notes) console.log(`      — ${n}`);
  for (const e of r.errors) console.log(`      ! ${e}`);
}
const bundleConfirm = run2.records.find((r) => r.id === 'bundle-confirm');
assert('bundle-confirm PASS (card reached, checks green)', bundleConfirm?.status === 'pass');
assert('bundle-confirm recorded confirmLeftOpen', bundleConfirm?.confirmLeftOpen === true);
const bundleOutcome = run2.records.find((r) => r.id === 'bundle-outcome');
assert('bundle-outcome skipped after "End run here"',
  bundleOutcome?.status === 'skipped' && bundleOutcome.notes.some((n) => n.includes('price-confirm')),
  bundleOutcome ? bundleOutcome.notes.join(' ') : 'missing');
const cardAfter = await harness.evaluate(
  () => document.querySelector('[data-testid="eb-confirm"]') !== null,
);
assert('eb-confirm STILL open after the run ended (runner never clicked it)', cardAfter);

// --- (e2) report truthfulness on the halted bundle run --------------
console.log('== (e2) walk report: halted run says where and why ==');
const bundle2 = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return { reportMd: b.reportMd };
});
assert('report states the early stop and its reason',
  bundle2.reportMd.includes('## Run stopped early') && bundle2.reportMd.includes('price-confirm card'),
  (bundle2.reportMd.split('\n').find((l) => l.includes('Stopped after')) ?? '').trim());
assert('awaiting-user event recorded: card reached → user ended the run',
  bundle2.reportMd.includes('awaiting-user — step `bundle-confirm`')
  && bundle2.reportMd.includes('→ user ended the run'));
assert('bundle-confirm itself stays PASS (reaching the card is its job)',
  bundle2.reportMd.includes('. bundle-confirm — PASS'));
assert('skipped remainder carries the gate reason verbatim',
  bundle2.reportMd.includes('run ended at the price-confirm card'));
console.log(`  summary line: ${bundle2.reportMd.split('\n').find((l) => l.startsWith('**Summary:**'))}`);

// --- §8.6–7 sections: full run with the proof playing the user ------
// The PROOF may click eb-confirm-run / eb-send — that is the user role.
// The runner never does; every click below happens in the harness page
// (the "user's" page), never through the panel or executor.

async function walkExtra() {
  return panel.evaluate(() => {
    const w = window.__tkWalk;
    if (!w) return null;
    return {
      status: w.status,
      settings: w.settings,
      scratch: w.scratch,
      cleanup: w.cleanup,
      halt: w.halt,
      events: w.events ?? [],
      records: w.records.map((r) => ({
        id: r.id, status: r.status, wall: r.wall, wallText: r.wallText,
        notes: r.notes, errors: r.errors,
        checks: r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`),
      })),
    };
  });
}

/** Pump the awaiting-user banner: act in the page (user role), then Continue. */
async function pumpUser(timeoutMs = 600_000) {
  const t0 = Date.now();
  const acted = [];
  for (;;) {
    const w = await walkRecords().catch(() => null);
    if (w?.status === 'done') return acted;
    if (Date.now() - t0 > timeoutMs) throw new Error('user pump timed out');
    const bannerVisible = await panel
      .evaluate(() => !document.getElementById('awaitBanner').hidden)
      .catch(() => false);
    if (bannerVisible) {
      const click = await harness
        .evaluate(() => {
          const confirm = document.querySelector('[data-testid="eb-confirm-run"]');
          if (confirm) { confirm.click(); return 'eb-confirm-run'; }
          const input = document.querySelector('[data-testid="eb-chat-input"]');
          const send = document.querySelector('[data-testid="eb-send"]');
          if (send && input && (input.value ?? '').trim().length > 0) { send.click(); return 'eb-send'; }
          return null;
        })
        .catch(() => null);
      if (click) acted.push(click);
      await sleep(click ? 1500 : 300);
      await panel.evaluate(() => document.getElementById('btnUserResume').click()).catch(() => {});
    }
    await sleep(600);
  }
}

/** Draft names in the library, as displayed (sorted for comparison). */
async function libraryNames() {
  return harness.evaluate(async () => {
    const toggle = document.querySelector('[data-testid="eb-drafts-toggle"]');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
      toggle.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    return [...document.querySelectorAll('[data-testid^="eb-draft-menu-"]')]
      .map((btn) => {
        let el = btn;
        let row = null;
        for (let i = 0; i < 10 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          if (el.querySelectorAll('[data-testid^="eb-draft-menu-"]').length === 1 && el.querySelector('span')) { row = el; break; }
        }
        const span = row?.querySelector('span');
        return (span?.childNodes?.[0]?.textContent ?? '').trim();
      })
      .sort();
  });
}

console.log('== (f) §8.6 full-catalog run on the mock, proof playing the user ==');
await panel.evaluate((url) => {
  document.getElementById('seededUrl').value = url;
}, seededUrl(BASE));
await setGroups(['first-run', 'library', 'interview', 'bundle', 'preview', 'banner', 'library-ops', 'walls']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const pumped = pumpUser();
const runFull = await waitWalkDone(600_000);
const userActs = await pumped;
console.log(`  user-role page clicks by the proof: ${userActs.join(', ') || '(none)'}`);
const full = await walkExtra();
for (const r of full.records) {
  console.log(`  ${r.id}: ${r.status}${r.wall ? ` [wall=${r.wall}]` : ''} [${r.checks.join(' · ')}]`);
  for (const e of r.errors) console.log(`      ! ${e}`);
}
const byId = Object.fromEntries(full.records.map((r) => [r.id, r]));
assert('user role confirmed spends in the page (confirm ×2 + send ×1)',
  userActs.filter((a) => a === 'eb-confirm-run').length === 2 && userActs.filter((a) => a === 'eb-send').length === 1,
  userActs.join(', '));
assert('no step FAILED in the full run', full.records.every((r) => r.status !== 'fail'),
  full.records.filter((r) => r.status === 'fail').map((r) => r.id).join(', ') || 'clean');
assert('interview-chat-turn PASS after the user-role send', byId['interview-chat-turn']?.status === 'pass',
  byId['interview-chat-turn']?.checks.join(' · '));
assert('bundle-outcome PASS behind the awaiting-user gate (was skipped in §8.4)',
  byId['bundle-outcome']?.status === 'pass', byId['bundle-outcome']?.checks.join(' · '));
assert('banner-generated PASS behind the awaiting-user gate (was skipped in §8.4)',
  byId['banner-generated']?.status === 'pass', byId['banner-generated']?.checks.join(' · '));
for (const id of ['broken-banner-fallback', 'broken-banner-regenerate-confirm', 'broken-banner-regenerated']) {
  assert(`${id} detection-driven → live-limited here (fresh seeded draft open, no dead banner)`,
    byId[id]?.status === 'live-limited' && byId[id].notes.some((n) => n.includes('cannot be manufactured')),
    byId[id]?.notes[0] ?? 'missing');
}
assert('save-and-new PASS on the scratch draft', byId['save-and-new']?.status === 'pass',
  byId['save-and-new']?.checks.join(' · '));
assert('drafts-library-ops PASS on the scratch draft', byId['drafts-library-ops']?.status === 'pass',
  byId['drafts-library-ops']?.checks.join(' · '));
assert('scratch draft carries the containment marker', /^walk-scratch-\d{8}-\d{6}$/.test(full.scratch?.name ?? ''),
  full.scratch?.name);
// In the FULL run the later walls visit reloads the seeded harness (a
// fresh in-memory seed), so the scratch is already gone when run-end
// cleanup looks; cleanup reporting it already-absent is truthful. The
// active two-tap deletion itself is proven strictly in (g).
assert('run-end cleanup accounted for the scratch draft (deleted or already gone, no failures)',
  Boolean(full.cleanup)
  && (full.cleanup?.failed ?? []).length === 0
  && [...(full.cleanup?.deleted ?? []), ...(full.cleanup?.alreadyAbsent ?? [])].includes(full.scratch?.name),
  JSON.stringify(full.cleanup));

console.log('== (f2) report bundle of the full run: new statuses + toggles, no mock labels ==');
const bundleFull = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return { reportMd: b.reportMd, paths: b.files.map((f) => f.path) };
});
assert('report header prints the persisted toggle states (§8.7)',
  bundleFull.reportMd.includes('allow scratch drafts ON') && bundleFull.reportMd.includes('step groups this run:'),
  (bundleFull.reportMd.split('\n').find((l) => l.includes('Settings')) ?? '').trim());
assert('report shows bundle-outcome and banner-generated as PASS',
  bundleFull.reportMd.includes('. bundle-outcome — PASS') && bundleFull.reportMd.includes('. banner-generated — PASS'));
assert('report shows the broken-banner settlement as LIVE-LIMITED',
  bundleFull.reportMd.includes('. broken-banner-fallback — LIVE-LIMITED')
  && bundleFull.reportMd.includes('cannot be manufactured'));
assert('report has the scratch section with the draft named and cleanup proven',
  bundleFull.reportMd.includes('## Scratch drafts (spec §5)')
  && bundleFull.reportMd.includes(full.scratch?.name ?? '(no scratch)')
  && bundleFull.reportMd.includes('cleanup: no scratch drafts remain.'));
assert('report uses live labels only — no MOCK-LIMITED anywhere',
  !bundleFull.reportMd.includes('MOCK-LIMITED'));
assert('summary line counts the full run truthfully',
  bundleFull.reportMd.includes('16 passed') && bundleFull.reportMd.includes('0 failed')
  && bundleFull.reportMd.includes('3 skipped') && bundleFull.reportMd.includes('3 live-limited'),
  (bundleFull.reportMd.split('\n').find((l) => l.startsWith('**Summary:**')) ?? '').trim());

console.log('== (f3) broken-banner trio runs for real when a dead-banner draft is open ==');
await harness.goto(seededUrl(BASE), { waitUntil: 'networkidle2', timeout: 60_000 });
await sleep(2500);
const openedBroken = await harness.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toggle = document.querySelector('[data-testid="eb-drafts-toggle"]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') { toggle.click(); await sleep(500); }
  // user role: open the seeded dead-banner draft by its row's Open button
  for (const btn of document.querySelectorAll('[data-testid="eb-drafts"] button')) {
    if (btn.textContent.trim() !== 'Open') continue;
    let el = btn;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const opens = [...el.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Open');
      if (opens.length === 1 && el.textContent.includes('Webinar invite')) { btn.click(); return true; }
    }
  }
  return false;
});
assert('user role opened “Webinar invite”', openedBroken);
await harness.waitForFunction(
  () => (document.querySelector('[data-testid="eb-banner-placeholder"]')?.textContent ?? '').includes('Banner image unavailable'),
  { timeout: 20_000, polling: 400 },
);
console.log('  dead-banner placeholder is showing in the open draft');
await setGroups(['banner']);
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const pumpedTrio = pumpUser(300_000);
const runTrio = await waitWalkDone(300_000);
await pumpedTrio;
const trio = await walkExtra();
for (const r of trio.records) console.log(`  ${r.id}: ${r.status} [${r.checks.join(' · ')}]`);
const trioById = Object.fromEntries(trio.records.map((r) => [r.id, r]));
assert('broken-banner-fallback PASS for real (detection positive)',
  trioById['broken-banner-fallback']?.status === 'pass', trioById['broken-banner-fallback']?.checks.join(' · '));
assert('broken-banner-regenerate-confirm PASS (priced-gate pattern)',
  trioById['broken-banner-regenerate-confirm']?.status === 'pass', trioById['broken-banner-regenerate-confirm']?.checks.join(' · '));
assert('broken-banner-regenerated PASS after the user-role confirm',
  trioById['broken-banner-regenerated']?.status === 'pass', trioById['broken-banner-regenerated']?.checks.join(' · '));

console.log('== (g) scratch containment: library names identical before/after ==');
await harness.goto(seededUrl(BASE), { waitUntil: 'networkidle2', timeout: 60_000 });
await sleep(2500);
const namesBefore = await libraryNames();
console.log(`  before: ${JSON.stringify(namesBefore)}`);
await setGroups(['library-ops']);
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const runOps = await waitWalkDone(300_000);
const ops = await walkExtra();
for (const r of ops.records) console.log(`  ${r.id}: ${r.status} [${r.checks.join(' · ')}]`);
const namesAfter = await libraryNames();
console.log(`  after:  ${JSON.stringify(namesAfter)}`);
assert('library lists exactly the seeded drafts before and after (scratch gone, seeds untouched)',
  JSON.stringify(namesAfter) === JSON.stringify(namesBefore) && !namesAfter.some((n) => n.includes('walk-scratch')),
  `${namesBefore.length} → ${namesAfter.length} drafts`);
assert('seeded names intact (the walk seed six)',
  ['Dark mode launch', 'October newsletter', 'Product tips digest', 'Spring launch announcement', 'Spring sale announcement', 'Webinar invite']
    .every((n) => namesAfter.includes(n)), namesAfter.join(' · '));
assert('cleanup recorded the deletion in this run too',
  (ops.cleanup?.deleted ?? []).length >= 1 && (ops.cleanup?.failed ?? []).length === 0,
  JSON.stringify(ops.cleanup));

console.log('== (h) §8.7 scratch toggle OFF: stateful steps skip, nothing is created ==');
await panel.evaluate(() => {
  const box = document.getElementById('optScratch');
  if (box.checked) box.click();
});
const storedOff = await panel.evaluate(async () => chrome.storage.local.get('tkSettingsV1'));
assert('toggle persisted OFF in chrome.storage.local',
  storedOff?.tkSettingsV1?.allowScratchDrafts === false, JSON.stringify(storedOff?.tkSettingsV1));
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const runOff = await waitWalkDone(300_000);
const off = await walkExtra();
for (const r of off.records) console.log(`  ${r.id}: ${r.status} — ${r.notes[0] ?? ''}`);
assert('both scratch-only steps skipped with the toggle reason',
  off.records.length === 2 && off.records.every(
    (r) => r.status === 'skipped' && r.notes.some((n) => n.includes('toggle is OFF')),
  ), off.records.map((r) => r.status).join(', '));
assert('no scratch draft was created while OFF', off.scratch === null, JSON.stringify(off.scratch));
const namesOff = await libraryNames();
assert('library untouched while OFF (whole run read-only)',
  JSON.stringify(namesOff) === JSON.stringify(namesBefore), namesOff.join(' · '));
await panel.evaluate(() => {
  const box = document.getElementById('optScratch');
  if (!box.checked) box.click();
});
const storedOn = await panel.evaluate(async () => chrome.storage.local.get('tkSettingsV1'));
assert('toggle persisted back ON', storedOn?.tkSettingsV1?.allowScratchDrafts === true);

console.log('== (i) §8.6 consent wall: detected-if-present on ?consent=ungrantable ==');
await panel.evaluate((url) => {
  document.getElementById('seededUrl').value = url;
}, `${seededUrl(BASE)}&consent=ungrantable`);
await setGroups(['interview', 'bundle']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const pumpedConsent = pumpUser(300_000);
const runConsent = await waitWalkDone(300_000);
await pumpedConsent;
const consent = await walkExtra();
for (const r of consent.records) {
  console.log(`  ${r.id}: ${r.status}${r.wall ? ` [wall=${r.wall}]` : ''}${r.wallText ? ` — “${r.wallText}”` : ''}`);
}
const chatTurn = consent.records.find((r) => r.id === 'interview-chat-turn');
assert('the acted step ends live-limited: consent (not failed, not faked)',
  chatTurn?.status === 'live-limited' && chatTurn?.wall === 'consent',
  chatTurn ? `${chatTurn.status}/${chatTurn.wall}` : 'missing');
assert('the wall state is recorded verbatim',
  (chatTurn?.wallText ?? '').includes('be granted in this context'), chatTurn?.wallText ?? 'missing');
assert('run stopped cleanly at the wall (later steps skipped with the reason, no FAILs)',
  consent.halt?.reason?.includes('consent wall') === true
  && consent.records.filter((r) => r.id !== 'interview-draft-opened' && r.id !== 'interview-chat-turn')
    .every((r) => r.status === 'skipped' && r.notes.some((n) => n.includes('consent wall')))
  && consent.records.every((r) => r.status !== 'fail'),
  consent.halt?.reason ?? 'no halt recorded');
const bundleConsent = await panel.evaluate(async () => {
  const b = await window.__tkWalkReport.buildFiles();
  return { reportMd: b.reportMd };
});
assert('report labels it LIVE-LIMITED: consent with the verbatim text',
  bundleConsent.reportMd.includes('. interview-chat-turn — LIVE-LIMITED: consent')
  && bundleConsent.reportMd.includes('Consent wall (verbatim): “Buzz spending can'),
  (bundleConsent.reportMd.split('\n').find((l) => l.includes('Consent wall')) ?? '').trim());
await panel.evaluate((url) => {
  document.getElementById('seededUrl').value = url;
}, seededUrl(BASE));

// --- (d) diagnostics regression --------------------------------------
// --- §8.8 (j): live-branch full run on the harness (proof override) --
console.log('== (j) §8.8 live-branch run (live-mode forced on the harness) ==');
await panel.evaluate(() => {
  const box = document.getElementById('optLiveBranch');
  if (box && !box.checked) box.click();
});
assert('live-branch override (optLiveBranch) engaged',
  await panel.evaluate(() => document.getElementById('optLiveBranch').checked === true));
await panel.evaluate((url) => { document.getElementById('seededUrl').value = url; }, seededUrl(BASE));
await setGroups(['first-run', 'library', 'interview', 'bundle', 'preview', 'banner', 'library-ops', 'walls']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const pumpedJ = pumpUser();
const runJ = await waitWalkDone(600_000);
const userActsJ = await pumpedJ;
const liveEx = await walkExtra();
const live = liveEx.records;
assert('live-branch run finished (not halted)', runJ.status === 'done' && !liveEx.halt, JSON.stringify(liveEx.halt));
for (const r of live) {
  console.log(`  ${r.id}: ${r.status}${r.status === 'pass' ? '' : ` — ${r.notes.filter((n) => !n.startsWith('awaiting-user:')).join(' | ')}`}`);
}
{
  const by = (id) => live.find((r) => r.id === id);
  const counts = { pass: 0, fail: 0, skipped: 0, 'live-limited': 0 };
  for (const r of live) if (counts[r.status] !== undefined) counts[r.status] += 1;
  // v0.2.4: interview-chat-turn now grades the sent turn by state.
  // The harness's mock host returns no text outputs, so the app
  // answers the proof's send with its honest no-reply note — a real
  // assistant reply cannot be manufactured here (settlement), so
  // that ONE step ends live-limited instead of passing on the
  // mock-shaped note assertions. Live counts: 15·0·3·4.
  assert('live-branch summary keeps the honest counts (15·0·3·4; chat turn limited by settlement)',
    counts.pass === 15 && counts.fail === 0 && counts.skipped === 3 && counts['live-limited'] === 4,
    `pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped} live-limited=${counts['live-limited']}`);
  const chatTurnLive = by('interview-chat-turn');
  assert('live interview-chat-turn: turn observed sent; no-reply note graded live-limited verbatim (never asserted as success)',
    chatTurnLive.status === 'live-limited' &&
      chatTurnLive.checks.some((c) => c.startsWith('✓') && c.includes('typed turn is in the transcript')) &&
      chatTurnLive.notes.some((n) => n.includes('no assistant reply followed to grade') && n.includes('didn’t reply')) &&
      chatTurnLive.notes.some((n) => n.includes('brief after the turn, verbatim')),
    chatTurnLive.notes.join(' | ').slice(0, 240));
  // first-run: live branch proves shell + transcript, names the
  // account draft as data, never asserts the seeded Untitled truth.
  const firstRun = by('first-run');
  assert('live first-run passed on state, not seed wording',
    firstRun.status === 'pass' &&
      firstRun.checks.length === 2 &&
      firstRun.checks.every((c) => c.startsWith('✓')) &&
      firstRun.notes.some((n) => n.includes('current draft on this account')),
    firstRun.checks.join(' | '));
  // seeded-library: the 6 names appear as NOTED DATA; no check asserts
  // a seed name.
  const seededLib = by('seeded-library');
  assert('live seeded-library passes with count + names noted (6 as data)',
    seededLib.status === 'pass' &&
      seededLib.checks.every((c) => !c.includes('Spring') && !c.includes('Webinar') && !c.includes('October') && !c.includes('Dark mode') && !c.includes('Product tips')) &&
      seededLib.notes.some((n) => n.includes('library on this account lists 6 draft')),
    seededLib.notes.filter((n) => n.includes('library on this account')).join(' ').slice(0, 200));
  assert('no seed-name check survives on the live library branch',
    !seededLib.checks.some((c) => c.includes('lists “')));
  // brief-ready: state-matched (a seeded draft’s brief really reads
  // ready), never opened-by-name.
  const brief = by('brief-ready');
  assert('live brief-ready passes against a state-matched draft',
    brief.status === 'pass' &&
      brief.checks.some((c) => c.includes('brief badge reads “ready”')) &&
      brief.notes.some((n) => n.includes('brief-ready state read from draft')),
    brief.checks.join(' | '));
  // the preview chain: matched to a draft WITH a package, proven by
  // before/after interaction, never canned strings.
  for (const id of ['finished-preview', 'widget-variant-switch', 'subject-pick', 'manual-edit-preview', 'export-copy']) {
    assert(`live ${id} passes on the state-matched draft`, by(id).status === 'pass',
      by(id).checks.filter((c) => c.startsWith('✗')).join(' | ') || by(id).notes.join(' | ').slice(0, 120));
  }
  const variant = by('widget-variant-switch');
  assert('live variant switch is a before/after assertion (no canned string)',
    variant.checks.some((c) => c.includes('preview text changed')) &&
      variant.notes.some((n) => n.includes('preview before:')) &&
      !variant.checks.some((c) => c.includes('40% off')),
    variant.notes.join(' | ').slice(0, 200));
  const subject = by('subject-pick');
  assert('live subject pick reads the picked text from the page (no canned subject)',
    subject.checks.some((c) => c.includes('editor subject follows the pick')) &&
      subject.notes.some((n) => n.includes('picked subject option')),
    subject.notes.join(' | ').slice(0, 200));
  const banner = by('banner-generate-confirm');
  assert('live banner-generate-confirm reached the priced card by state, not by name',
    banner.status === 'pass' && banner.checks.some((c) => c.includes('priced consent')),
    banner.checks.join(' | '));
  // the gated continuations still ran behind the proof-as-user clicks
  assert('live run acted through the user-gate continuations (bundle/banner outcomes pass)',
    by('bundle-outcome').status === 'pass' && by('banner-generated').status === 'pass',
    `bundle-outcome=${by('bundle-outcome').status} banner-generated=${by('banner-generated').status}`);
  assert('live run still never clicked a runner-side confirm (user-role clicks only)',
    userActsJ.filter((a) => a === 'eb-confirm-run').length >= 2 && userActsJ.filter((a) => a === 'eb-send').length >= 1,
    `sends=${userActsJ.filter((a) => a === 'eb-send').length} confirms=${userActsJ.filter((a) => a === 'eb-confirm-run').length} (all proof-as-user)`);
}

// --- §8.8 (j2): no qualifying draft anywhere → chain live-limits, ---
// --- the run CONTINUES into the next group ---------------------------
console.log('== (j2) §8.8 live-branch: no qualifying draft → chain live-limited, run continues ==');
await panel.evaluate((url) => { document.getElementById('seededUrl').value = url; }, `${BASE}/`);
// A genuinely empty account. The harness always boots with the
// screenshot rig's one packaged demo draft, so reload bare and delete
// it through the page (the proof in the user role — page prep, not
// the runner). The panel skips navigation afterward (same URL as the
// tab's), so the deletion survives into the run.
await harness.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
await harness.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toggle = document.querySelector('[data-testid="eb-drafts-toggle"]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') { toggle.click(); await sleep(400); }
  const menu = document.querySelector('[data-testid^="eb-draft-menu-"]');
  if (!menu) return;
  const id = menu.getAttribute('data-testid').slice('eb-draft-menu-'.length);
  menu.click();
  await sleep(500);
  const del = () => document.querySelector(`[data-testid="eb-delete-${id}"]`);
  del()?.click();
  await sleep(500);
  del()?.click(); // two-tap confirm
  await sleep(800);
});
const leftAfterDelete = await harness.evaluate(() => document.querySelectorAll('[data-testid^="eb-draft-menu-"]').length);
assert('page prep emptied the account (demo draft deleted)', leftAfterDelete === 0, `${leftAfterDelete} drafts remain`);
await setGroups(['preview', 'library-ops']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const runJ2 = await waitWalkDone(300_000);
const j2Ex = await walkExtra();
const j2 = j2Ex.records;
for (const r of j2) {
  console.log(`  ${r.id}: ${r.status}${r.status === 'live-limited' ? ` — ${r.notes.filter((n) => n.startsWith('live-limited:') || n.startsWith('dependency:')).join(' | ').slice(0, 160)}` : ''}`);
}
{
  const by = (id) => j2.find((r) => r.id === id);
  const chain = ['finished-preview', 'widget-variant-switch', 'subject-pick', 'manual-edit-preview', 'export-copy'];
  assert('run finished (no fail-stop on unmet premises)', runJ2.status === 'done' && !j2Ex.halt, JSON.stringify(j2Ex.halt));
  for (const id of chain) {
    const r = by(id);
    assert(`${id} ends live-limited with the dependency reason (not fail)`,
      r && r.status === 'live-limited' && r.notes.some((n) => n.includes('no draft on this account shows a finished package')),
      r ? r.notes.join(' | ').slice(0, 200) : 'missing record');
  }
  assert('RUN CONTINUED past the limited chain — library-ops groups still passed',
    by('save-and-new').status === 'pass' && by('drafts-library-ops').status === 'pass',
    `save-and-new=${by('save-and-new')?.status} drafts-library-ops=${by('drafts-library-ops')?.status}`);
  const counts = { pass: 0, fail: 0, skipped: 0, 'live-limited': 0 };
  for (const r of j2) if (counts[r.status] !== undefined) counts[r.status] += 1;
  assert('no-qualifying-draft summary: 2 passed · 0 failed · 5 live-limited',
    counts.pass === 2 && counts.fail === 0 && counts['live-limited'] === 5,
    `pass=${counts.pass} fail=${counts.fail} limited=${counts['live-limited']}`);
}
// restore mock-mode state for the remaining sections
await panel.evaluate(() => {
  const box = document.getElementById('optLiveBranch');
  if (box && box.checked) box.click();
});
await panel.evaluate((url) => { document.getElementById('seededUrl').value = url; }, seededUrl(BASE));

// --- (l2) v0.2.4 auto-resume: Send observed in the page -----------
// The proof (user role) clicks ONLY eb-send — the panel's Resume is
// never touched. The step must notice the sent turn itself, resume,
// and reach the live post-send grading. Harness settlement: the
// mock host returns no text, so the app answers with its honest
// no-reply note and the step ends live-limited with it verbatim.
console.log('== (l2) v0.2.4 auto-resume: Send in the page, no panel Resume click ==');
await panel.evaluate(() => {
  const box = document.getElementById('optLiveBranch');
  if (box && !box.checked) box.click();
});
await setGroups(['interview']);
await harness.bringToFront();
const l2t0 = Date.now();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await panel.waitForFunction(
  () => !document.getElementById('awaitBanner').hidden,
  { timeout: 90_000, polling: 500 },
);
console.log('  step parked at AWAITING-USER (banner up)');
const l2Banner = await panel.evaluate(() => document.getElementById('awaitText').textContent);
assert('live halt text tells the user Send is self-serve (no Resume needed)',
  l2Banner.includes('continue on its own'), l2Banner);
const l2Send = await harness.evaluate(() => {
  const input = document.querySelector('[data-testid="eb-chat-input"]');
  const send = document.querySelector('[data-testid="eb-send"]');
  if (send && input && (input.value ?? '').trim().length > 0) { send.click(); return true; }
  return false;
});
assert('proof (user role) clicked Send in the page — and nothing in the panel', l2Send);
const runL2 = await waitWalkDone(120_000);
const l2ElapsedMs = Date.now() - l2t0;
const l2 = await walkExtra();
for (const r of l2.records) {
  console.log(`  ${r.id}: ${r.status} [${r.checks.join(' · ')}]`);
  for (const n of r.notes) console.log(`      — ${n}`);
}
const l2ById = Object.fromEntries(l2.records.map((r) => [r.id, r]));
const l2Turn = l2ById['interview-chat-turn'];
assert('step resumed on its own and finished without any 180s park-kill (well under the old fuse)',
  runL2.status === 'done' && l2ElapsedMs < 90_000 && !l2Turn.errors.some((e) => e.includes('no progress')),
  `${Math.round(l2ElapsedMs / 1000)}s elapsed`);
assert('record says the act was observed in the page (auto-resume, runner never clicked Send)',
  l2Turn.notes.some((n) => n.includes('observed in the page')),
  l2Turn.notes.join(' | ').slice(0, 200));
assert('live post-send grading ran: sent turn checked, no-reply note live-limited verbatim (harness settlement)',
  l2Turn.status === 'live-limited'
  && l2Turn.checks.some((c) => c.startsWith('✓') && c.includes('typed turn is in the transcript'))
  && l2Turn.notes.some((n) => n.includes('no assistant reply followed to grade') && n.includes('didn’t reply'))
  && l2Turn.notes.some((n) => n.includes('brief after the turn, verbatim')),
  l2Turn.notes.join(' | ').slice(0, 240));
const l2Events = await panel.evaluate(() =>
  (window.__tkWalk.events ?? []).filter((e) => e.kind === 'awaiting-user')
    .map((e) => ({ stepId: e.stepId, outcome: e.outcome })));
assert('awaiting-user event annotated “observed in the page” (not a Resume click)',
  l2Events.some((e) => e.stepId === 'interview-chat-turn' && (e.outcome ?? '').includes('observed in the page')),
  JSON.stringify(l2Events));

// --- (l3) v0.2.4 Stop ends a parked dispatch promptly ------------
// Park the chat step again, then Stop: the executor's park resolves
// via the control channel and its record returns — the dispatch
// must end with the ended-step note, never a liveness timeout.
console.log('== (l3) v0.2.4 Stop during the park: record returns, no timeout ==');
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await panel.waitForFunction(
  () => !document.getElementById('awaitBanner').hidden,
  { timeout: 90_000, polling: 500 },
);
await panel.evaluate(() => document.getElementById('btnWalkStop').click());
const runL3 = await waitWalkDone(60_000);
const l3 = await walkExtra();
for (const r of l3.records) console.log(`  ${r.id}: ${r.status} — ${r.notes.join(' | ').slice(0, 160)}`);
const l3Turn = l3.records.find((r) => r.id === 'interview-chat-turn');
assert('Stop ended the parked step: record returned with the ended note, no liveness timeout, no FAIL',
  runL3.status === 'done' && l3Turn && l3Turn.status !== 'fail'
  && l3Turn.errors.length === 0
  && l3Turn.notes.some((n) => n.includes('nothing was sent by the runner')),
  l3Turn ? `${l3Turn.status} — ${l3Turn.notes.join(' | ').slice(0, 160)}` : 'missing record');
assert('run halt recorded as stopped-by-user',
  (l3.halt?.reason ?? '').includes('run stopped by you'), l3.halt?.reason ?? '(none)');
await panel.evaluate(() => {
  const box = document.getElementById('optLiveBranch');
  if (box && box.checked) box.click();
});

// --- (m) v0.4.0 Auto mode: no waits, capped confirms --------------
// Auto ON (cap 1000): the interview step clicks Send itself and the
// bundle price gate auto-confirms, so interview+bundle runs end to
// end with NOBODY at the panel. Then Auto with cap 1: the same gate
// must refuse (over cap) and fall back to the manual banner.
console.log('== (m) v0.4.0 Auto mode: end-to-end without waiting ==');
await panel.evaluate((url) => { document.getElementById('seededUrl').value = url; }, seededUrl(BASE));
await panel.evaluate(() => {
  const on = document.getElementById('optAuto');
  if (on && !on.checked) on.click();
  const cap = document.getElementById('optAutoCap');
  cap.value = '1000';
  cap.dispatchEvent(new Event('change'));
});
await setGroups(['interview', 'bundle']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
const runM = await waitWalkDone(300_000);
const mEx = await walkExtra();
for (const r of mEx.records) console.log(`  ${r.id}: ${r.status} — ${r.notes.join(' | ').slice(0, 140)}`);
const mTurn = mEx.records.find((r) => r.id === 'interview-chat-turn');
const mOutcome = mEx.records.find((r) => r.id === 'bundle-outcome');
assert('auto run finished end-to-end (no halt, no panel clicks)',
  runM.status === 'done' && !mEx.halt, JSON.stringify(mEx.halt));
assert('auto interview step sent the turn itself',
  mTurn && mTurn.status === 'pass' && mTurn.notes.some((n) => n.includes('Auto mode: Send clicked')),
  mTurn ? mTurn.notes.join(' | ').slice(0, 200) : 'missing record');
assert('auto bundle-outcome passed behind the auto-confirmed card',
  mOutcome && mOutcome.status === 'pass', mOutcome ? mOutcome.status : 'missing record');
assert('auto-confirm event recorded with the price',
  (mEx.events ?? []).some((e) => e.kind === 'auto-confirm' && (e.outcome ?? '').includes('auto-confirmed')),
  JSON.stringify(mEx.events ?? []));
assert('auto settings printed on the run record',
  mEx.settings?.autoRun === true && mEx.settings?.autoCapBuzz === 1000,
  JSON.stringify(mEx.settings));

// cap 1: the gate refuses and the manual banner takes over
await panel.evaluate(() => {
  const cap = document.getElementById('optAutoCap');
  cap.value = '1';
  cap.dispatchEvent(new Event('change'));
});
await setGroups(['bundle']);
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await panel.waitForFunction(
  () => !document.getElementById('awaitBanner').hidden,
  { timeout: 90_000, polling: 500 },
);
console.log('  over-cap card fell back to the manual banner');
await panel.evaluate(() => document.getElementById('btnUserEnd').click());
const runM2 = await waitWalkDone(120_000);
const m2Ex = await walkExtra();
assert('over-cap auto-confirm refused, run ended at the manual gate',
  (m2Ex.events ?? []).some((e) => e.kind === 'auto-confirm' && (e.detail ?? '').includes('exceeds the Auto cap')),
  JSON.stringify(m2Ex.events ?? []));
await panel.evaluate(() => {
  const on = document.getElementById('optAuto');
  if (on && on.checked) on.click();
});

// --- (n) v0.7.9: app-named walk IDs + Auto-ship at walk end --------
// The bundle folder leaf (the run ID the owner points Muse at)
// names the app that ran: walk-email-builder-YYYY-MM-DD-HHMM
// (seconds suffix only if two runs of one app stamp the same
// minute). With Auto-ship on, a finished run ships its own bundle
// exactly once through the manual Ship path — S3 stubbed here, as
// in the (e2) ship section. Off ships nothing. A failing ship
// surfaces in shipStatus and leaves the Ship button live.
console.log('== (n) v0.7.9 app-named run IDs + auto-ship ==');
await setGroups(['first-run']);
await panel.evaluate(async () => {
  window.__tkOrigFetch = window.fetch;
  window.__tkShipUrls = [];
  window.fetch = async (url, opts) => {
    window.__tkShipUrls.push(String(url));
    return { ok: true, status: 200, text: async () => '' };
  };
  await chrome.storage.local.set({ tkS3V1: {
    endpoint: 'https://toil-s3.example.invalid', bucket: 'toil-killer-runs',
    accessKey: 'toil-killer-svc', secretKey: 'proof-secret-not-real',
  } });
  const shipBox = document.getElementById('optAutoShip');
  if (!shipBox.checked) { shipBox.checked = true; shipBox.dispatchEvent(new Event('change', { bubbles: true })); }
});
await harness.bringToFront();
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await waitWalkDone();
await panel.waitForFunction(
  () => (window.__tkShipUrls ?? []).length > 0,
  { timeout: 60_000, polling: 500 },
).catch(() => null);
const autoShipOn = await panel.evaluate(async () => {
  const callsWhenFired = window.__tkShipUrls.length;
  await new Promise((r) => setTimeout(r, 2000));
  const ctxs = Object.values(window.__tkWalkReport.contextsByTab());
  return {
    calls: window.__tkShipUrls,
    firedOnce: window.__tkShipUrls.length === callsWhenFired,
    status: document.getElementById('shipStatus').textContent,
    shippedRunId: ctxs.map((c) => c.shippedRunId).find(Boolean) ?? null,
    shipDisabled: document.getElementById('btnShip').disabled,
  };
});
assert('auto-ship ON ships the finished run without a Ship click', autoShipOn.calls.length > 1,
  `${autoShipOn.calls.length} PUTs`);
assert('auto-ship objects live under the app-named run folder',
  autoShipOn.calls.every((u) => u.includes('/toil-killer/walk-email-builder-')),
  autoShipOn.calls[0] ?? '(none)');
assert('auto-ship uploads ship-manifest.json last',
  (autoShipOn.calls.at(-1) ?? '').endsWith('/ship-manifest.json'), autoShipOn.calls.at(-1) ?? '(none)');
assert('auto-ship fires exactly once — no retry loop', autoShipOn.firedOnce,
  `${autoShipOn.calls.length} PUTs after settle`);
assert('auto-ship success reaches shipStatus and the run-ID pointer',
  autoShipOn.status.includes('S3 ✓') && Boolean(autoShipOn.shippedRunId)
    && autoShipOn.calls[0].includes(`/${autoShipOn.shippedRunId}/`),
  `${autoShipOn.status} · pointer ${autoShipOn.shippedRunId}`);
assert('Ship button stays enabled after an auto-ship', autoShipOn.shipDisabled === false);

// OFF: the next finished run must not ship anything.
await panel.evaluate(() => {
  window.__tkShipUrls = [];
  const shipBox = document.getElementById('optAutoShip');
  if (shipBox.checked) { shipBox.checked = false; shipBox.dispatchEvent(new Event('change', { bubbles: true })); }
});
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await waitWalkDone();
await sleep(2500);
const autoShipOffCalls = await panel.evaluate(() => window.__tkShipUrls.length);
assert('auto-ship OFF ships nothing at walk end', autoShipOffCalls === 0, `${autoShipOffCalls} PUTs`);

// Failure: a 500 from S3 surfaces in shipStatus; manual Ship (with a
// healthy endpoint) still works afterwards.
await panel.evaluate(() => {
  window.__tkShipUrls = [];
  window.fetch = async () => ({ ok: false, status: 500, text: async () => 'proof outage' });
  const shipBox = document.getElementById('optAutoShip');
  if (!shipBox.checked) { shipBox.checked = true; shipBox.dispatchEvent(new Event('change', { bubbles: true })); }
});
await panel.evaluate(() => document.getElementById('btnWalkRun').click());
await waitWalkDone();
await panel.waitForFunction(
  () => document.getElementById('shipStatus').textContent.includes('auto-ship failed'),
  { timeout: 60_000, polling: 500 },
).catch(() => null);
const autoShipFail = await panel.evaluate(() => ({
  status: document.getElementById('shipStatus').textContent,
  shipDisabled: document.getElementById('btnShip').disabled,
}));
assert('failed auto-ship surfaces in shipStatus (never swallowed)',
  autoShipFail.status.includes('auto-ship failed') && autoShipFail.status.includes('500'),
  autoShipFail.status);
assert('manual Ship stays available after an auto-ship failure', autoShipFail.shipDisabled === false);
await panel.evaluate(() => {
  window.__tkShipUrls = [];
  window.fetch = async (url, opts) => {
    window.__tkShipUrls.push(String(url));
    return { ok: true, status: 200, text: async () => '' };
  };
  document.getElementById('btnShip').click();
});
await panel.waitForFunction(
  () => document.getElementById('shipStatus').textContent.includes('S3 ✓'),
  { timeout: 60_000, polling: 500 },
).catch(() => null);
const manualRetry = await panel.evaluate(() => ({
  status: document.getElementById('shipStatus').textContent,
  calls: window.__tkShipUrls.length,
}));
assert('manual Ship still works after an auto-ship failure',
  manualRetry.status.includes('S3 ✓') && manualRetry.calls > 1, manualRetry.status);
await panel.evaluate(async () => {
  const shipBox = document.getElementById('optAutoShip');
  if (shipBox.checked) { shipBox.checked = false; shipBox.dispatchEvent(new Event('change', { bubbles: true })); }
  await chrome.storage.local.remove('tkS3V1');
  window.fetch = window.__tkOrigFetch;
});

console.log('== (d) spike diagnostics still work ==');
await panel.evaluate(() => document.getElementById('btnInject').click());
await panel.waitForFunction(
  () => document.getElementById('verdictInject').textContent.includes('PASS'),
  { timeout: 30_000, polling: 500 },
);
console.log('  ✓ injection probe PASS (panel verdict)');

await browser.close();
if (serverProc) {
  try { process.kill(-serverProc.pid, 'SIGTERM'); } catch { /* already gone */ }
}
console.log(failures === 0 ? '\nPROOF OK — all assertions green' : `\nPROOF FAILED — ${failures} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;

