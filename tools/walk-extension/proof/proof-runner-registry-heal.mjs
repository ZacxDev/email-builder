// Toil-Killer headless proof — frame-registry self-heal (v0.7.2).
// Mock harness only — no live origin, no Buzz.
//
// Regression being proven: v0.7.1 auto-select reads the tab's frames
// from the background hub's in-memory registry (tk-get-frames). That
// registry is populated only by content-script tk-frame-hello
// announcements, which fire at page load (plus a <=20s retry while
// the app root is missing). MV3 service workers restart routinely;
// every restart wipes the registry, already-loaded tabs never
// re-announce, and every tab read "No app in this tab" with Run
// fail-closed — on tabs that worked minutes earlier.
//
// This proof: load an app tab, wait until its announce window is
// long past, STOP the extension service worker (the registry dies
// with it), then open a FRESH panel (fresh contexts — it must learn
// the tab's app from tk-get-frames alone). The fixed background
// probes the tab's frames on demand and refills the registry, so
// the panel auto-selects the type with no tab reload.
//
// Run:  node tools/walk-extension/proof/proof-runner-registry-heal.mjs

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXT_DIR = path.join(APP_DIR, 'tools', 'walk-extension');
const EB = 'http://localhost:5186';
const CHROME = '/home/hatch/workspace/.cft/chrome-linux64/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(label, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
}

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
console.log('== harness: email-builder :5186 ==');

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

async function findSwTarget() {
  return (await browser.targets()).find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  );
}
let sw = null;
for (let i = 0; i < 30 && !sw; i++) {
  sw = await findSwTarget();
  if (!sw) await sleep(500);
}
if (!sw) { console.log('NO_SW'); process.exit(1); }
const extId = new URL(sw.url()).host;

const MOCK_IMG_SVG = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>` +
    `<rect width='1024' height='576' fill='#1971c2'/>` +
    `<text x='512' y='290' font-family='Arial' font-size='72' font-weight='700' fill='white' text-anchor='middle'>MOCK</text></svg>`,
);
const appPage = await browser.newPage();
await appPage.setRequestInterception(true);
appPage.on('request', (req) => {
  const u = req.url();
  if (u.startsWith(EB) || u.startsWith('data:') || u.startsWith('blob:')) void req.continue();
  else if (req.resourceType() === 'image') void req.respond({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMG_SVG });
  else void req.abort();
});
await appPage.goto(`${EB}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
await appPage.waitForFunction(
  () => document.querySelector('[data-testid="eb-app"]') !== null,
  { timeout: 30_000, polling: 500 },
);
console.log('  ✓ harness renders eb-app');
// The content script announces at load, then retries for at most
// ~20s while the root is missing. Wait well past that window so no
// announcement can possibly save the registry after the kill.
console.log('  …waiting out the content-script announce window (25s)');
await sleep(25_000);

async function panelState(panel) {
  return panel.evaluate(() => ({
    app: document.getElementById('appSelect').value,
    tabInfo: document.getElementById('tabInfo').textContent,
    catalog: document.getElementById('catalogLine').textContent,
    runDisabled: document.getElementById('btnWalkRun').disabled,
  }));
}
async function openPanel() {
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'load', timeout: 30_000 });
  await panel.waitForFunction(
    () => (document.getElementById('targetSelect')?.options.length ?? 0) >= 1,
    { timeout: 30_000, polling: 500 },
  );
  await sleep(1500);
  return panel;
}

console.log('== baseline: panel detects the app via the registry ==');
let panel = await openPanel();
let st = await panelState(panel);
assert('baseline: target type auto-selected (Email Builder)', st.app === 'email-builder', JSON.stringify(st));
assert('baseline: Run enabled', st.runDisabled === false);
const appTabId = await panel.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url?.startsWith('http://localhost:5186'))?.id ?? null;
});

console.log('== kill the service worker (registry dies with it) ==');
async function stopServiceWorker() {
  const target = await findSwTarget();
  if (!target) return false;
  const worker = await target.worker();
  if (!worker) return false;
  // For a service_worker target this issues Target.closeTarget —
  // the worker process dies and its in-memory registry with it,
  // exactly like a routine MV3 service-worker restart.
  await worker.close();
  return true;
}
assert('service worker stopped via CDP', await stopServiceWorker());
for (let i = 0; i < 20 && (await findSwTarget()); i++) await sleep(500);
assert('service worker target is gone (registry wiped)', !(await findSwTarget()));
await panel.close();

console.log('== fresh panel, dead registry, untouched app tab ==');
panel = await openPanel();
// The user is looking at the app tab; the panel view follows it.
// (In this harness the panel is a tab of its own, so bring the app
// tab to the front — the same tab-activation the real side panel
// keys off.)
await appPage.bringToFront();
st = await panelState(panel);
// give detection its on-demand probe a fair chance to land
for (let i = 0; i < 20 && st.app !== 'email-builder'; i++) {
  await sleep(1000);
  st = await panelState(panel);
}
assert('after SW restart: target type auto-selected again (no tab reload)',
  st.app === 'email-builder', JSON.stringify(st));
assert('after SW restart: status line names the auto choice',
  st.tabInfo.includes('Auto: Email Builder'), st.tabInfo);
assert('after SW restart: Run enabled again', st.runDisabled === false);
assert('after SW restart: catalog primed for the detected app',
  st.catalog.includes('Email Builder'), st.catalog.slice(0, 80));

const framesAfter = await panel.evaluate(async (tabId) => {
  const res = await chrome.runtime.sendMessage({ type: 'tk-get-frames', tabId });
  return res?.frames ?? [];
}, appTabId);
assert('registry refilled by the on-demand probe (frames present with eb-app seen)',
  framesAfter.some((f) => f.ebAppFound || f.appFound),
  JSON.stringify(framesAfter).slice(0, 200));

await browser.close();
for (const proc of booted) {
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
}
console.log(failures === 0
  ? '\nREGISTRY-HEAL PROOF OK — detection survives a service-worker restart'
  : `\nREGISTRY-HEAL PROOF FAILED — ${failures} assertion(s)`);
process.exitCode = failures === 0 ? 0 : 1;
