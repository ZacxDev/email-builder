// Toil-Killer side panel.
//
// Two halves:
//  1. WALK RUNNER (§8.3–4): loads the shared step catalog
//     (tools/walk/steps.json, synced into this package by
//     tools/walk/sync-steps.mjs), verifies its own copy against the
//     recorded sha256, and runs selected step groups against the
//     target tab through the in-page executor (content.js). Per-step
//     status streams back live; screenshots come from the background
//     capture service. Priced steps stop at the confirm card and wait
//     for the user's own click — this panel contains no code path
//     that clicks anything in the page; it only sends messages.
//  2. DIAGNOSTICS: the four P0 spike probes, kept as the debugging
//     surface (injection / drive / capture / embedded diagnosis).

const PROBE_TEXT = 'Spike probe — toil-killer test, please disregard.';
const STATUS_TEXT = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIPPED',
  'live-limited': 'LIVE-LIMITED',
  'awaiting-user': 'AWAITING-USER',
  running: 'RUNNING',
  queued: 'QUEUED',
};

// App registry (v0.6.0): one extension, per-app bindings. Each
// binding names its catalog + stamp, the root testid its frame
// reports, and the noun its scratch containment uses. The runner,
// report writer, Ship, Auto, and diagnostics below are shared.
const APP_BINDINGS = {
  'email-builder': {
    id: 'email-builder',
    label: 'Email Builder',
    catalog: 'steps.json',
    stamp: 'steps.sync.json',
    rootTestid: 'eb-app',
    frameFlag: 'ebAppFound',
    scratchNoun: 'draft',
    scratchNounPlural: 'drafts',
  },
  'open-datasets': {
    id: 'open-datasets',
    label: 'Open Datasets',
    catalog: 'steps-open-datasets.json',
    stamp: 'steps-open-datasets.sync.json',
    rootTestid: 'dc-community',
    frameFlag: 'dcAppFound',
    scratchNoun: 'dataset',
    scratchNounPlural: 'datasets',
  },
};

const state = {
  appId: 'email-builder',
  tab: null,
  frames: [],
  appFrameId: null, // auto-detected: the frame that reports the binding's root
  catalog: null,
  catalogHash: null,
  catalogStamp: null, // steps.sync.json, as loaded (for the report header)
  baseline: null, // {file: dataUrl} imported baseline PNGs, session only
  baselineMeta: null,
  results: {}, // probe action -> evidence (object or per-frame map)
  shotDataUrl: null,
  // persisted toggles (§8.7): the extension's own settings only.
  // groupsByApp keeps each binding's group selection separate.
  settings: { allowScratchDrafts: true, groups: {}, groupsByApp: {}, appId: 'email-builder', autoRun: false, autoCapBuzz: 150 },
  // walk run state
  walk: null, // {runId, status, records: [], shots: {file: dataUrl}, settings, scratch, cleanup}
  walkRunning: false,
  walkPaused: false,
  stopRequested: false,
  endAfterStep: false, // an awaiting-user "End run here" was chosen
  pendingDecision: null, // {kind: 'mid-step'|'gate', stepId, resolve}
  progressEvents: 0, // tk-walk-progress count this session (v0.2.2 stale-frame hint)
  // Proof override (§8.8): force the account-shaped live branches even
  // on the localhost harness, so they are rehearsable headlessly. On a
  // real origin the executor uses live branches regardless.
  liveBranch: false,
  consoleHookNote: null,
};

const SETTINGS_KEY = 'tkSettingsV1';

// ---------------------------------------------------------------------
// Persisted toggles (§8.7): chrome.storage.local, extension-local only.
// Defaults are the safest read of §5: scratch drafts allowed (stateful
// groups cannot run without them), every step group selected.
// ---------------------------------------------------------------------

function binding() {
  return APP_BINDINGS[state.appId] ?? APP_BINDINGS['email-builder'];
}

async function loadSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = got?.[SETTINGS_KEY];
    if (saved && typeof saved === 'object') {
      const groupsByApp =
        saved.groupsByApp && typeof saved.groupsByApp === 'object' ? saved.groupsByApp : {};
      // Pre-0.6.0 flat `groups` belonged to Email Builder (the only binding).
      if (!groupsByApp['email-builder'] && saved.groups && typeof saved.groups === 'object') {
        groupsByApp['email-builder'] = saved.groups;
      }
      state.settings = {
        allowScratchDrafts: saved.allowScratchDrafts !== false,
        groups: saved.groups && typeof saved.groups === 'object' ? saved.groups : {},
        groupsByApp,
        appId: APP_BINDINGS[saved.appId] ? saved.appId : 'email-builder',
        autoRun: saved.autoRun === true,
        autoCapBuzz: Number.isFinite(saved.autoCapBuzz) && saved.autoCapBuzz >= 0 ? saved.autoCapBuzz : 150,
      };
      state.appId = state.settings.appId;
    }
  } catch {
    /* storage unavailable — session defaults stand */
  }
  $('appSelect').value = state.appId;
  $('optScratch').checked = state.settings.allowScratchDrafts;
  $('optAuto').checked = state.settings.autoRun;
  $('optAutoCap').value = String(state.settings.autoCapBuzz);
}

function autoSettings() {
  const cap = Number.parseFloat($('optAutoCap').value);
  return {
    autoRun: $('optAuto').checked === true,
    autoCapBuzz: Number.isFinite(cap) && cap >= 0 ? cap : 0,
  };
}

async function persistSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: state.settings });
  } catch {
    /* storage unavailable — settings live for this panel session only */
  }
}

function groupSelection() {
  const out = {};
  for (const box of $('groupList').querySelectorAll('input[type="checkbox"]')) {
    out[box.dataset.group] = box.checked;
  }
  return out;
}

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setVerdict(id, verdict, cls) {
  const el = $(id);
  el.textContent = verdict ? `— ${verdict}` : '';
  el.className = `verdict ${cls ?? ''}`;
}

function showJson(id, value) {
  const el = $(id);
  el.hidden = false;
  el.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------
// Catalog: load steps.json + its sync stamp, re-hash the copy, display.
// Drift between the mock runner and this package is visible at a glance.
// ---------------------------------------------------------------------

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadCatalog() {
  const line = $('catalogLine');
  const b = binding();
  try {
    const [stepsBuf, stamp] = await Promise.all([
      fetch(chrome.runtime.getURL(b.catalog)).then((r) => r.arrayBuffer()),
      fetch(chrome.runtime.getURL(b.stamp)).then((r) => r.json()),
    ]);
    const catalog = JSON.parse(new TextDecoder().decode(stepsBuf));
    const hash = await sha256Hex(stepsBuf);
    state.catalog = catalog;
    state.catalogHash = hash;
    state.catalogStamp = stamp;
    const inSync = hash === stamp.sha256;
    const extVersion = chrome.runtime.getManifest().version;
    line.title = `${catalog.app} v${catalog.version} · ${stamp.source} · synced ${stamp.syncedAt}`;
    line.innerHTML =
      `${b.label} · ${catalog.steps.length} steps · sha256 ${hash.slice(0, 12)}… · ` +
      (inSync
        ? `<span class="sync-ok">✓ sync</span>`
        : `<span class="sync-bad">⚠ DRIFT ${String(stamp.sha256).slice(0, 12)}… — npm run steps:sync</span>`) +
      ` · extension v${extVersion}`;
    buildGroupList();
  } catch (err) {
    line.innerHTML = `<span class="sync-bad">Step catalog failed to load: ${err?.message ?? err} — run npm run steps:sync and reload the extension.</span>`;
  }
}

function buildGroupList() {
  const wrap = $('groupList');
  wrap.innerHTML = '';
  for (const group of state.catalog.groups) {
    const count = state.catalog.steps.filter((s) => s.group === group).length;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = (state.settings.groupsByApp[state.appId] ?? {})[group] !== false; // persisted per app (§8.7)
    box.dataset.group = group;
    box.addEventListener('change', () => {
      state.settings.groupsByApp[state.appId] = groupSelection();
      state.settings.groups = state.settings.groupsByApp[state.appId];
      persistSettings();
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${group} `));
    const span = document.createElement('span');
    span.className = 'count';
    span.textContent = `(${count})`;
    label.appendChild(span);
    wrap.appendChild(label);
  }
}

function selectedSteps() {
  const groups = new Set(
    [...$('groupList').querySelectorAll('input[type="checkbox"]:checked')].map((b) => b.dataset.group),
  );
  return state.catalog.steps.filter((s) => groups.has(s.group));
}

// ---------------------------------------------------------------------
// Targets: which tab (and frame) the walk + probes act on.
// ---------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function framesOf(tabId) {
  const res = await chrome.runtime.sendMessage({ type: 'tk-get-frames', tabId });
  return res?.frames ?? [];
}

async function refreshTargets() {
  const sel = $('targetSelect');
  const tabs = await chrome.tabs.query({});
  const rows = [];
  const flag = binding().frameFlag;
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith('chrome-extension://')) continue;
    const frames = await framesOf(tab.id);
    rows.push({ tab, frames, hasApp: frames.some((f) => f[flag]) });
  }
  sel.innerHTML = '';
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = String(row.tab.id);
    opt.textContent = `${row.hasApp ? `● ${binding().rootTestid}` : '○ no app'} · ${row.tab.url}`;
    sel.appendChild(opt);
  }
  const active = await activeTab();
  const pick =
    rows.find((r) => r.hasApp) ??
    rows.find((r) => r.tab.id === active?.id) ??
    rows[0];
  if (pick) {
    sel.value = String(pick.tab.id);
    await setTarget(pick.tab);
  } else {
    $('tabInfo').textContent = 'No web tabs found.';
  }
}

async function setTarget(tab) {
  state.tab = tab;
  state.appFrameId = null;
  $('tabInfo').textContent = tab.url ?? '(no URL)';
  await refreshFrames();
}

async function refreshFrames() {
  if (!state.tab) return;
  state.frames = await framesOf(state.tab.id);
  const sel = $('frameSelect');
  sel.innerHTML = '';
  if (state.frames.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no injected frames — reload the app tab)';
    sel.appendChild(opt);
    return;
  }
  for (const frame of state.frames) {
    const opt = document.createElement('option');
    opt.value = String(frame.frameId);
    opt.textContent = `${frame.isTop ? 'top' : `frame ${frame.frameId}`} · ${binding().rootTestid} ${frame[binding().frameFlag] ? 'seen' : 'not seen'} · ${frame.url}`;
    sel.appendChild(opt);
  }
  const appFrame = state.frames.find((f) => f[binding().frameFlag]) ?? state.frames[0];
  sel.value = String(appFrame.frameId);
  if (appFrame[binding().frameFlag]) state.appFrameId = appFrame.frameId;
}

async function sendProbe(frameId, action) {
  return chrome.tabs.sendMessage(
    state.tab.id,
    { type: 'tk-probe-run', action },
    { frameId },
  );
}

// "The app frame" = whichever frame reports eb-app. Embedded apps
// always live in a child iframe; standalone apps are the top frame.
// The background enumerates frames and asks each resident probe —
// nobody picks a frame by hand.
async function findAppFrame() {
  const res = await chrome.runtime.sendMessage({ type: 'tk-find-app-frame', tabId: state.tab.id, appId: state.appId });
  state.results.find = res;
  if (res?.frameId != null) {
    state.appFrameId = res.frameId;
    const sel = $('frameSelect');
    if (sel && [...sel.options].some((o) => o.value === String(res.frameId))) {
      sel.value = String(res.frameId);
    }
    return res;
  }
  return null;
}

// Version handshake (v0.2.2, §8.8 hardening). The failure it
// prevents: after an extension reload, an app tab that was never
// reloaded still holds the OLD content script. That script answers
// probes — so the panel "finds" the app — but it predates (or
// postdates) this panel's step protocol and never executes new
// tk-walk-step messages; step 1 would sit at RUNNING until the 180s
// dispatch timeout. So before a run's first step: ask the app frame
// for its executor build (stamped on every probe response since
// v0.2.2, read from the frame's own manifest at runtime) and compare
// with this panel's manifest version. Returns null when the build
// matches; otherwise the plain verdict to surface — the run must
// NOT start on a mismatch or on silence.
async function checkExecutorVersion() {
  const panelVersion = chrome.runtime.getManifest().version;
  const noAnswer =
    `the app frame did not answer the version check (this panel is v${panelVersion}); ` +
    'the app tab may still be holding a Toil-Killer script from before the extension reload. ' +
    'The run did not start. Reload the app tab, then Run again.';
  if (state.appFrameId == null) return noAnswer;
  let evidence = null;
  try {
    evidence = await sendProbe(state.appFrameId, 'inject');
  } catch {
    evidence = null; // no resident script answered at all
  }
  if (!evidence) return noAnswer;
  const frameVersion = evidence.executorVersion ?? null;
  if (frameVersion === panelVersion) return null;
  if (!frameVersion) {
    return (
      'the app tab is running an older Toil-Killer script — it answers probes but reports no build ' +
      `version, while this panel is v${panelVersion}; it cannot execute this panel's steps. ` +
      'The run did not start. Reload the app tab so it picks up the current script, then Run again.'
    );
  }
  return (
    `the app tab is running Toil-Killer v${frameVersion} but this panel is v${panelVersion} — ` +
    'mismatched builds cannot execute each other\'s steps. The run did not start. ' +
    'Reload the app tab (and reload the extension too, if the tab is the newer side), then Run again.'
  );
}

// ---------------------------------------------------------------------
// Walk runner (§8.4 protocol): run / pause / stop, per-step status,
// 'needs your click' pause, fail-stop. The panel dispatches one step
// at a time to the in-page executor and renders what streams back.
// ---------------------------------------------------------------------

function walkSend(msg) {
  return chrome.tabs.sendMessage(state.tab.id, msg, { frameId: state.appFrameId });
}

function control(action, extra = {}) {
  if (!state.tab || state.appFrameId == null || !state.walk) return;
  chrome.tabs
    .sendMessage(state.tab.id, { type: 'tk-walk-control', runId: state.walk.runId, action, ...extra }, { frameId: state.appFrameId })
    .catch(() => {});
}

// Installed into the app's main world so the content script can hear
// console errors (isolated worlds can't). Best-effort diagnostics.
function tkInstallConsoleHook() {
  if (window.__tkConsoleHook) return 'already-installed';
  window.__tkConsoleHook = true;
  const orig = console.error.bind(console);
  console.error = (...args) => {
    try {
      const text = args
        .map((a) => {
          try {
            return typeof a === 'string' ? a : a?.message ?? JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ')
        .slice(0, 300);
      window.postMessage({ __tkConsole: true, text }, '*');
    } catch { /* never break the app over diagnostics */ }
    orig(...args);
  };
  return 'installed';
}

async function installConsoleHook() {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tab.id, frameIds: [state.appFrameId] },
      world: 'MAIN',
      func: tkInstallConsoleHook,
    });
  } catch (err) {
    if (!state.consoleHookNote) {
      state.consoleHookNote = `console-error hook could not be installed (${err?.message ?? err}); page errors are still captured.`;
    }
  }
}

function statusClass(status) {
  return (
    {
      pass: 'pass',
      fail: 'fail',
      skipped: 'st-skipped',
      'live-limited': 'st-limited',
      'awaiting-user': 'st-awaiting',
      running: 'st-running',
      queued: 'st-skipped',
    }[status] ?? ''
  );
}

function renderStepRow(record) {
  const li = document.querySelector(`#stepList [data-step-id="${CSS.escape(record.id)}"]`);
  if (!li) return;
  const passed = record.checks.filter((c) => c.ok).length;
  li.querySelector('.st-status').textContent = STATUS_TEXT[record.status] ?? record.status;
  li.querySelector('.st-status').className = `st-status ${statusClass(record.status)}`;
  li.querySelector('.st-meta').textContent =
    `${record.checks.length ? `${passed}/${record.checks.length} checks · ` : ''}${record.file}` +
    (record.shotBytes ? ` · shot ~${Math.round(record.shotBytes / 1024)} KB` : '');
  const detail = [
    ...record.checks.map((c) => `${c.ok ? '✓' : '✗ FAIL'} ${c.label}`),
    ...record.notes.map((n) => `— ${n}`),
    ...record.errors.map((e) => `! ${e}`),
  ].join('\n');
  const detailEl = li.querySelector('.st-detail');
  detailEl.textContent = detail;
  detailEl.hidden = !detail;
}

function buildStepRows(steps) {
  const list = $('stepList');
  list.innerHTML = '';
  steps.forEach((def, i) => {
    const li = document.createElement('li');
    li.className = 'step-row';
    li.dataset.stepId = def.id;
    li.innerHTML =
      `<span class="st-status st-skipped">QUEUED</span> ` +
      `<span class="st-name">${i + 1} · ${def.name}</span> ` +
      `<span class="st-meta">${def.group} · ${def.liveClass} · ${def.file}</span>` +
      `<div class="st-detail" hidden></div>`;
    list.appendChild(li);
  });
}

function markRemainingSkipped(steps, fromIndex, reason) {
  for (let i = fromIndex; i < steps.length; i++) {
    const def = steps[i];
    if (state.walk.records.some((r) => r.id === def.id)) continue;
    const record = {
      id: def.id, name: def.name, group: def.group, file: def.file,
      liveClass: def.liveClass, status: 'skipped',
      checks: [], notes: [reason], errors: [], confirmLeftOpen: false, viewport: null,
    };
    state.walk.records.push(record);
    renderStepRow(record);
  }
}

function showAwaitBanner(text) {
  $('awaitText').textContent = text;
  $('awaitBanner').hidden = false;
}
function hideAwaitBanner() {
  $('awaitBanner').hidden = true;
}

// The awaiting-user decision: one banner serves both the mid-step
// halt (executor is waiting in the page) and the post-step gate
// (a price-confirm card was left open). Buttons resolve it.
function awaitDecision(kind, stepId) {
  return new Promise((resolve) => {
    state.pendingDecision = { kind, stepId, resolve };
  });
}

// Annotate the newest unresolved awaiting-user event for a step with
// the user's choice, so the report can say "card reached → continued /
// ended" verbatim (spec §5 wants those events on the record).
function annotateAwaitEvent(stepId, outcome) {
  const events = state.walk?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].stepId === stepId && events[i].outcome === null) {
      events[i].outcome = outcome;
      return;
    }
  }
}

function resolveDecision(decision) {
  const pending = state.pendingDecision;
  state.pendingDecision = null;
  hideAwaitBanner();
  if (decision === 'end') state.endAfterStep = true; // run loop stops after the current step
  if (!pending) return;
  annotateAwaitEvent(
    pending.stepId,
    decision === 'end' ? 'user ended the run' : 'user acted in the page; runner continued',
  );
  if (pending.kind === 'mid-step') {
    control('user-decision', { decision });
    // The executor resolves the step; the run loop sees the record.
    pending.resolve(decision);
  } else {
    pending.resolve(decision);
  }
}

// Progress streamed from the executor while a step runs.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'tk-walk-progress' || !state.walk) return;
  if (msg.runId !== state.walk.runId) return;
  state.progressEvents += 1; // v0.2.2: liveness signal for the stale-frame hint
  const li = document.querySelector(`#stepList [data-step-id="${CSS.escape(msg.stepId ?? '')}"]`);
  if (!li) return;
  const detailEl = li.querySelector('.st-detail');
  detailEl.hidden = false;
  if (msg.kind === 'check') {
    detailEl.textContent += `${msg.ok ? '✓' : '✗ FAIL'} ${msg.label}\n`;
  } else if (msg.kind === 'note') {
    detailEl.textContent += `— ${msg.text}\n`;
  } else if (msg.kind === 'awaiting-user') {
    li.querySelector('.st-status').textContent = 'AWAITING-USER';
    li.querySelector('.st-status').className = 'st-status st-awaiting';
    // On the run record: the card/send point was reached; the outcome
    // is filled in when the user chooses (annotateAwaitEvent).
    state.walk.events.push({
      kind: 'awaiting-user', stepId: msg.stepId, detail: msg.reason, outcome: null,
    });
    showAwaitBanner(`Step “${msg.stepId}”: ${msg.reason}`);
    // The decision is delivered by the banner buttons via
    // resolveDecision('resume'|'end') -> control('user-decision').
    // state.pendingDecision is armed here so the buttons know the
    // executor (not the run loop) is waiting.
    state.pendingDecision = { kind: 'mid-step', stepId: msg.stepId, resolve: () => {} };
  } else if (msg.kind === 'user-acted') {
    // v0.2.4: the executor saw the user's act in the page itself and
    // resumed without a Resume click. Retire the banner/decision and
    // record the outcome on the awaiting-user event.
    annotateAwaitEvent(
      msg.stepId,
      'user’s act observed in the page — runner resumed on its own (no Resume click)',
    );
    if (state.pendingDecision?.kind === 'mid-step' && state.pendingDecision?.stepId === msg.stepId) {
      state.pendingDecision = null;
      hideAwaitBanner();
    }
    li.querySelector('.st-status').textContent = 'RUNNING';
    li.querySelector('.st-status').className = 'st-status st-running';
  }
});

/**
 * Whether the tab is already showing this visit. Chrome may
 * canonicalize the seed query differently from the string the panel
 * computed (encoding), and a reload would wipe in-page state the run
 * deliberately set up (e.g. a pre-opened draft) — so "same visit" is
 * judged on the state-bearing parts only: origin, path, seed, consent.
 */
function sameVisitUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin
      && ua.pathname === ub.pathname
      && ua.searchParams.get('seed') === ub.searchParams.get('seed')
      && ua.searchParams.get('consent') === ub.searchParams.get('consent')
      && ua.searchParams.get('community') === ub.searchParams.get('community')
      && ua.searchParams.get('viewer') === ub.searchParams.get('viewer')
      && ua.searchParams.get('balance') === ub.searchParams.get('balance')
    );
  } catch {
    return a === b;
  }
}

/** Navigate the target tab to a visit URL and wait for the app frame. */
async function navigateVisit(url) {
  const tab = await chrome.tabs.get(state.tab.id);
  if (!sameVisitUrl(tab.url ?? '', url)) {
    await chrome.tabs.update(state.tab.id, { url });
    // Wait for the load to finish first: mid-navigation, the OLD
    // page's frames can still answer probes, and "found the app" must
    // mean the NEW page's app. (The executor also waits for eb-app
    // itself — this just keeps the panel honest.)
    const loadDeadline = Date.now() + 30_000;
    for (;;) {
      const t = await chrome.tabs.get(state.tab.id).catch(() => null);
      if (t && t.status === 'complete') break;
      if (Date.now() > loadDeadline) break;
      await sleep(400);
    }
    // Then wait for the content script, i.e. until the app frame answers.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = await findAppFrame().catch(() => null);
      if (found) break;
      if (Date.now() > deadline) throw new Error(`app frame did not answer after navigating to ${url}`);
      await sleep(500);
    }
  } else {
    await findAppFrame();
  }
  if (state.appFrameId == null) throw new Error(`no frame reports ${binding().rootTestid} in the target tab`);
  await installConsoleHook();
  await sleep(300);
}

/** Resolve a catalog visit to a URL for mock rehearsal; null = no nav. */
function visitUrl(visitDef) {
  const origin = new URL(state.tab.url).origin;
  const isMock = origin.includes('localhost') || origin.includes('127.0.0.1');
  if (!isMock) return null; // live: steps run on the tab as-is (§6)
  if (visitDef.setup === 'unseeded') return `${origin}/`;
  if (visitDef.setup === 'query') return `${origin}/?${visitDef.query}`;
  if (visitDef.setup === 'seeded') return $('seededUrl').value.trim() || null;
  return null;
}

async function captureStep(record) {
  const res = await chrome.runtime.sendMessage({ type: 'tk-capture', tabId: state.tab.id });
  if (res?.dataUrl) {
    state.walk.shots[record.file] = res.dataUrl;
    record.shotBytes = Math.round((res.dataUrl.length * 3) / 4);
  } else {
    // The mock walk fails a step whose screenshot fails; mirror that.
    record.errors.push(`screenshot failed: ${res?.error ?? 'unknown error'}`);
    if (record.status === 'pass') record.status = 'fail';
  }
}

/**
 * Run-end scratch cleanup (§8.6): whatever the run's outcome — done,
 * failed, stopped, fail-stopped — the scratch draft this run created
 * is deleted through the executor, which re-verifies id+name per
 * delete. Failures land on walk.cleanup so the report names the
 * leftovers loudly instead of implying a clean account.
 */
async function runScratchCleanup() {
  const scratch = state.walk?.scratch;
  if (!scratch?.id) return;
  const failAll = (error) => ({
    deleted: [],
    alreadyAbsent: [],
    failed: [{ id: scratch.id, name: scratch.name, error }],
  });
  try {
    await findAppFrame().catch(() => null);
    if (state.appFrameId == null || !state.tab) {
      state.walk.cleanup = failAll(`no frame reports ${binding().rootTestid} at run end — cleanup could not run.`);
      return;
    }
    const res = await walkSend({ type: 'tk-walk-cleanup', runId: state.walk.runId, scratch, appId: state.walk.appId ?? state.appId });
    state.walk.cleanup = res ?? failAll('cleanup returned no answer from the page.');
  } catch (err) {
    state.walk.cleanup = failAll(`cleanup message failed: ${err?.message ?? err}`);
  }
}

// The dispatch liveness clock (v0.2.4): resolves { timeout: true }
// only after budgetMs of total silence — zero progress events —
// while the step is neither settled nor parked awaiting the user.
// A step parked at a §5 user halt has NO dispatch deadline: it ends
// only when the park resolves (Resume/End/Stop in the page, or the
// executor observing the user's act), and its record returns then.
// Progress flowing resets the clock: a step streaming proof of life
// is alive however long it runs. This replaces the wall-clock race
// that shot a legitimately parked dispatch at 180s on the second
// live run. budgetMs is a parameter so the headless proof can drive
// this exact accounting with a short fuse (the same pattern as the
// executor's tk-watchdog-dev hook, v0.2.3).
const DISPATCH_INACTIVITY_MS = 180_000;
function watchDispatchLiveness({ isSettled, isParked, progressCount, budgetMs = DISPATCH_INACTIVITY_MS }) {
  return (async () => {
    let lastCount = progressCount();
    let quietMs = 0;
    for (;;) {
      await sleep(500);
      if (isSettled()) return new Promise(() => {}); // race already decided
      if (isParked()) {
        lastCount = progressCount();
        quietMs = 0;
        continue;
      }
      const count = progressCount();
      if (count !== lastCount) {
        lastCount = count;
        quietMs = 0;
        continue;
      }
      quietMs += 500;
      if (quietMs >= budgetMs) return { timeout: true, quietMs };
    }
  })();
}

async function dispatchStep(def) {
  const li = document.querySelector(`#stepList [data-step-id="${CSS.escape(def.id)}"]`);
  if (li) {
    li.querySelector('.st-status').textContent = 'RUNNING';
    li.querySelector('.st-status').className = 'st-status st-running';
  }
  // Stale-frame hint (v0.2.2): if the page sends zero progress events
  // for ~20s while this step is still open, the in-page script is
  // probably a pre-reload build that will never answer — annotate
  // the row with the likely cause instead of letting RUNNING sit
  // silently until the timeout.
  const progressBefore = state.progressEvents;
  let settled = false;
  const responsePromise = walkSend({
    type: 'tk-walk-step', runId: state.walk.runId, step: def, appId: state.walk.appId ?? state.appId,
    allowScratch: state.walk.settings?.allowScratch !== false,
    scratch: state.walk.scratch ?? null,
    armed: state.walk.armed ?? {},
    liveBranch: state.liveBranch === true,
    autoRun: state.walk.settings?.autoRun === true,
    autoCapBuzz: state.walk.settings?.autoCapBuzz ?? 0,
  }).then((res) => { settled = true; return res; });
  void (async () => {
    await sleep(20_000);
    if (settled || state.progressEvents !== progressBefore) return;
    const row = document.querySelector(`#stepList [data-step-id="${CSS.escape(def.id)}"]`);
    const detailEl = row?.querySelector('.st-detail');
    if (!detailEl) return;
    detailEl.hidden = false;
    detailEl.textContent +=
      '⚠ no progress from the page for 20s — a stale in-page script looks likely ' +
      '(the extension was reloaded after this tab loaded). If it never resumes: ' +
      'Stop, reload the app tab, then Run again.\n';
  })();
  // v0.2.4: progress-aware dispatch deadline (see watchDispatchLiveness).
  // Parked awaiting the user → no deadline at all. Otherwise the
  // deadline is 180s of silence, not 180s from dispatch.
  const response = await Promise.race([
    responsePromise,
    watchDispatchLiveness({
      isSettled: () => settled,
      isParked: () =>
        state.pendingDecision?.kind === 'mid-step' && state.pendingDecision?.stepId === def.id,
      progressCount: () => state.progressEvents,
      budgetMs: DISPATCH_INACTIVITY_MS,
    }),
  ]);
  settled = true;
  if (response?.timeout) {
    return {
      id: def.id, name: def.name, group: def.group, file: def.file, liveClass: def.liveClass,
      status: 'fail', checks: [], notes: [],
      errors: [`executor sent no progress for ${DISPATCH_INACTIVITY_MS / 1000}s while not parked awaiting you — step failed rather than hang the run.`],
      confirmLeftOpen: false, viewport: null,
    };
  }
  return response;
}

async function runWalk() {
  if (state.walkRunning) return;
  if (!state.catalog) { setVerdict('walkStatus', 'catalog not loaded', 'fail'); return; }
  if (!state.tab) { setVerdict('walkStatus', 'no target tab — Refresh targets first', 'fail'); return; }
  const steps = selectedSteps();
  if (steps.length === 0) { setVerdict('walkStatus', 'no step groups selected', 'fail'); return; }

  // Mock rehearsal pre-flight: seeded visits need their URL up front.
  const origin = new URL(state.tab.url).origin;
  const isMock = origin.includes('localhost') || origin.includes('127.0.0.1');
  if (isMock && !$('seededUrl').value.trim()) {
    const needsSeed = steps.some((s) => state.catalog.visits[s.visit]?.setup === 'seeded');
    if (needsSeed) {
      setVerdict('walkStatus', 'seeded visits selected but no seeded URL — paste one above (npm run seed:url)', 'fail');
      return;
    }
  }

  state.walkRunning = true;
  state.walkPaused = false;
  state.stopRequested = false;
  state.endAfterStep = false;
  state.consoleHookNote = null;
  state.walk = {
    runId: `walk-${Date.now()}`,
    appId: state.appId,
    appLabel: binding().label,
    status: 'running',
    startedAt: new Date().toISOString(),
    targetUrl: state.tab.url ?? '(unknown tab URL)',
    frameId: state.appFrameId,
    selectedCount: steps.length,
    catalogHash: state.catalogHash,
    // §8.7: the toggle states this run executes under, printed in the
    // report header. Groups = the groups the selected steps belong to.
    settings: {
      allowScratch: state.settings.allowScratchDrafts,
      groups: [...new Set(steps.map((s) => s.group))],
      // §8.8 proof override, printed in the report header: on the
      // harness this forces the account-shaped live branches.
      liveBranchForced: state.liveBranch === true,
      // Auto mode (v0.4.0): the user's standing opt-in for this run,
      // read once at Run so mid-run toggles cannot change the deal.
      ...autoSettings(),
    },
    scratch: null, // {id, name, copies} once a stateful step creates it
    armed: {}, // run-scoped handler flags (e.g. dead-banner flow armed)
    cleanup: null, // {deleted, alreadyAbsent, failed} from run-end cleanup
    records: [],
    shots: {},
    events: [], // awaiting-user points, annotated with the user's choice
    halt: null, // {index, reason} when the run stopped early (report says where/why)
  };
  window.__tkWalk = state.walk;
  buildStepRows(steps);
  $('btnWalkRun').disabled = true;
  $('btnWalkPause').disabled = false;
  $('btnWalkStop').disabled = false;
  setVerdict('walkStatus', `running ${steps.length} steps…`, '');

  // Split into consecutive visit runs, like the mock runner.
  const runs = [];
  for (const def of steps) {
    const last = runs[runs.length - 1];
    if (last && last.visit === def.visit) last.steps.push(def);
    else runs.push({ visit: def.visit, steps: [def] });
  }

  let halted = null; // {index, reason} once the run fail-stops
  let flatIndex = 0;
  let handshakeDone = false; // v0.2.2: version gate runs once, before step 1
  try {
    for (const run of runs) {
      const url = visitUrl(state.catalog.visits[run.visit]);
      if (url) await navigateVisit(url);
      else if (state.appFrameId == null) {
        await findAppFrame();
        if (state.appFrameId == null) throw new Error(`no frame reports ${binding().rootTestid} in the target tab — reload the app tab`);
        await installConsoleHook();
      }
      for (const def of run.steps) {
        if (state.stopRequested) {
          halted = { index: flatIndex, reason: 'run stopped by you.' };
          break;
        }
        while (state.walkPaused && !state.stopRequested) await sleep(200);
        if (state.stopRequested) {
          halted = { index: flatIndex, reason: 'run stopped by you.' };
          break;
        }
        if (!handshakeDone) {
          // v0.2.2 version handshake: the frame is resolved by now
          // (post-navigation on mock visits, find-app-frame on live).
          // A stale in-page script would answer this probe but never
          // execute a step — refuse to start rather than hang.
          handshakeDone = true;
          const verdict = await checkExecutorVersion();
          if (verdict) {
            halted = { index: flatIndex, reason: verdict };
            break;
          }
        }
        const record = await dispatchStep(def);
        state.walk.records.push(record);
        if (record.scratch) state.walk.scratch = record.scratch;
        if (record.armed) state.walk.armed = record.armed;
        // A consent-limited step still gets its screenshot (§5: the
        // wall state is recorded as text AND image); gated skips and
        // handler-less limited steps never executed, so no shot.
        if (record.status !== 'skipped' && !(record.status === 'live-limited' && !record.wall)) {
          await captureStep(record);
        }
        renderStepRow(record);
        flatIndex += 1;

        if (state.stopRequested) {
          halted = { index: flatIndex, reason: 'run stopped by you.' };
          break;
        }
        if (record.wall === 'consent') {
          // §5: a consent wall ends the run cleanly — it is not a
          // failure, and nothing past it is improvised.
          halted = {
            index: flatIndex,
            reason: `consent wall detected at step “${def.id}” — recorded verbatim (see that step) and screenshotted, never clicked through (§5); run stopped cleanly.`,
          };
          break;
        }
        if (state.endAfterStep) {
          halted = { index: flatIndex, reason: 'run ended at the user-action point — your choice; the runner clicked nothing.' };
          break;
        }
        if (record.status === 'fail') {
          halted = {
            index: flatIndex,
            reason: `fail-stop: step “${def.id}” failed (spec §5 — the run does not improvise past a failure).`,
          };
          break;
        }
        // Price-confirm gate. Manual (default, §5): the runner never
        // clicks it — the user acts in the page. Auto (v0.4.0, the
        // user's opt-in): the executor clicks it only when the card's
        // stated price is at/under the run's Buzz cap; over-cap or
        // unpriced cards fall back to the manual gate below. Consent
        // walls never reach here — they stop the run earlier (§5).
        if (record.confirmLeftOpen && flatIndex < steps.length) {
          if (state.walk.settings?.autoRun) {
            const auto = await walkSend({
              type: 'tk-walk-auto-confirm', runId: state.walk.runId, appId: state.walk.appId ?? state.appId,
              capBuzz: state.walk.settings.autoCapBuzz ?? 0,
            }).catch((err) => ({ clicked: false, reason: `auto-confirm message failed: ${err?.message ?? err}` }));
            state.walk.events.push({
              kind: 'auto-confirm',
              stepId: def.id,
              detail: auto?.clicked
                ? `price-confirm auto-clicked at ${auto.price} Buzz (cap ${state.walk.settings.autoCapBuzz})`
                : `auto-confirm refused: ${auto?.reason ?? 'unknown reason'}`,
              outcome: auto?.clicked ? 'auto-confirmed by the runner under Auto mode' : 'fell back to the manual gate',
            });
            if (auto?.clicked) continue;
          }
          state.walk.events.push({
            kind: 'awaiting-user',
            stepId: def.id,
            detail: 'price-confirm card left open in the page; the runner will not click it',
            outcome: null,
          });
          showAwaitBanner(
            `Step “${def.id}” left a price-confirm card open in the page. ` +
              'The runner will not click it. Click Confirm in the app yourself if you want the spend to happen, then Continue — or End run here.',
          );
          const decision = await awaitDecision('gate', def.id);
          if (decision === 'end') {
            halted = { index: flatIndex, reason: 'run ended at the price-confirm card — your choice; nothing was clicked by the runner.' };
            break;
          }
          hideAwaitBanner();
        }
      }
      if (halted) break;
    }
  } catch (err) {
    halted = { index: flatIndex, reason: `run halted: ${err?.message ?? err}` };
  }

  if (halted) {
    markRemainingSkipped(steps, halted.index, halted.reason);
    state.walk.halt = halted; // the report states where the run stopped, and why
  }
  // §5 containment: the scratch draft dies with the run, however it ended.
  await runScratchCleanup();
  state.walk.frameId = state.appFrameId ?? state.walk.frameId;
  state.walk.status = 'done';
  const counts = { pass: 0, fail: 0, skipped: 0, 'live-limited': 0, 'awaiting-user': 0 };
  for (const r of state.walk.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  setVerdict(
    'walkStatus',
    `finished — ${counts.pass} passed · ${counts.fail} failed · ${counts.skipped} skipped · ${counts['live-limited']} live-limited`,
    counts.fail ? 'fail' : 'pass',
  );
  if (halted && counts.fail === 0) {
    $('walkStatus').textContent += ` (${halted.reason})`;
  }
  if (state.consoleHookNote) {
    $('walkStatus').textContent += ` (${state.consoleHookNote})`;
  }
  if (state.walk.cleanup?.failed?.length) {
    const names = state.walk.cleanup.failed.map((f) => `“${f.name}”`).join(', ');
    const b = APP_BINDINGS[state.walk.appId] ?? binding();
    $('walkStatus').textContent += ` ⚠ scratch cleanup incomplete — leftover ${b.scratchNoun}(s) ${names}; delete by hand (see report).`;
  }
  state.walkRunning = false;
  $('btnWalkRun').disabled = false;
  $('btnWalkPause').disabled = true;
  $('btnWalkStop').disabled = true;
  $('btnWalkPause').textContent = 'Pause';
  // The finished (or stopped) run can now be turned into the bundle.
  $('btnBundle').disabled = false;
  $('btnShip').disabled = false;
  $('btnSaveBaseline').disabled = false;
  if (!$('bundleFolder').value.trim()) $('bundleFolder').value = defaultBundleFolder();
}

$('btnWalkRun').addEventListener('click', runWalk);
$('btnWalkPause').addEventListener('click', () => {
  if (!state.walkRunning) return;
  state.walkPaused = !state.walkPaused;
  $('btnWalkPause').textContent = state.walkPaused ? 'Resume' : 'Pause';
  control(state.walkPaused ? 'pause' : 'resume');
  setVerdict('walkStatus', state.walkPaused ? 'paused — resume when ready' : 'running…', '');
});
$('btnWalkStop').addEventListener('click', () => {
  if (!state.walkRunning) return;
  state.stopRequested = true;
  state.walkPaused = false;
  control('stop');
  if (state.pendingDecision) resolveDecision('end');
  setVerdict('walkStatus', 'stopping…', '');
});
$('btnUserResume').addEventListener('click', () => resolveDecision('resume'));
$('btnUserEnd').addEventListener('click', () => resolveDecision('end'));
$('btnTargets').addEventListener('click', refreshTargets);
$('targetSelect').addEventListener('change', async () => {
  const tabId = Number($('targetSelect').value);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await setTarget(tab);
});

// ---------------------------------------------------------------------
// Report writer (§8.5): the same artifact family as the mock walk
// (tools/walk/run.mjs, "report + strips") — report.md + strip.html +
// taste-strip.html + one PNG per executed step under the catalog file
// names, downloaded as one dated bundle via chrome.downloads.
// Labels are the live ones, never the mock's: a step the user ended
// at the §5 action point is AWAITING-USER-ENDED, not PASS, and a
// state with no screenshot gets no dangling image link. This section
// only reads run state and downloads files — it clicks nothing,
// anywhere (the §5 rail is untouched).
// ---------------------------------------------------------------------

function catalogStep(id) {
  return state.catalog?.steps.find((s) => s.id === id) ?? null;
}
function catalogNumber(id) {
  const i = state.catalog ? state.catalog.steps.findIndex((s) => s.id === id) : -1;
  return i >= 0 ? i + 1 : 0;
}

/** Live-truthful status label for a walk record. */
function liveStatusLabel(record) {
  switch (record.status) {
    case 'fail': return 'FAIL';
    case 'live-limited': return record.wall === 'consent' ? 'LIVE-LIMITED: consent' : 'LIVE-LIMITED';
    case 'skipped': return 'SKIPPED';
    case 'awaiting-user': return 'AWAITING-USER';
    case 'pass':
      // The executor leaves this note verbatim when the user ended
      // the run at the action point: the flow halted before its
      // assertions completed, so PASS would be borrowed green.
      return record.notes.some(
        (n) => n.includes('run ended at the user-action point') || n.includes('turn left typed and unsent'),
      )
        ? 'AWAITING-USER-ENDED'
        : 'PASS';
    default:
      return String(record.status).toUpperCase();
  }
}

function loadImageEl(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/** % of pixels that differ between two PNG data URLs — run.mjs's
 *  canvas compare, unchanged (400px-wide downscale, channels >16). */
async function diffPctPng(aUrl, bUrl) {
  const [ia, ib] = await Promise.all([loadImageEl(aUrl), loadImageEl(bUrl)]);
  const W = 400;
  const scale = W / ia.naturalWidth;
  const H = Math.max(1, Math.round(ia.naturalHeight * scale));
  const draw = (img) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  };
  const da = draw(ia);
  const db = draw(ib);
  let diff = 0;
  const total = W * H;
  for (let i = 0; i < da.length; i += 4) {
    if (
      Math.abs(da[i] - db[i]) > 16 ||
      Math.abs(da[i + 1] - db[i + 1]) > 16 ||
      Math.abs(da[i + 2] - db[i + 2]) > 16
    ) {
      diff++;
    }
  }
  return (diff / total) * 100;
}

/** Baseline diff rows, or null when no baseline was imported. */
async function computeDiffs() {
  if (!state.baseline || !state.walk) return null;
  const out = [];
  for (const r of state.walk.records) {
    const cur = state.walk.shots[r.file];
    if (!cur) continue; // no current screenshot — nothing to compare
    const base = state.baseline[r.file];
    if (!base) {
      out.push({ file: r.file, state: 'new', pct: null });
      continue;
    }
    if (base === cur) {
      out.push({ file: r.file, state: 'unchanged', pct: 0 });
      continue;
    }
    const pct = await diffPctPng(base, cur).catch(() => null);
    // 2% triage threshold (run.mjs): identical-code runs show ~0–1.7%
    // raster jitter; real layout/copy changes move well past 2%.
    // Flags are triage for the taste call, not verdicts.
    out.push({ file: r.file, state: pct !== null && pct > 2 ? 'changed' : 'unchanged', pct });
  }
  return out;
}

function walkCounts(records) {
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0, 'LIVE-LIMITED': 0, 'AWAITING-USER-ENDED': 0, 'AWAITING-USER': 0 };
  for (const r of records) {
    let label = liveStatusLabel(r);
    if (label === 'LIVE-LIMITED: consent') label = 'LIVE-LIMITED'; // one bucket in the summary
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function walkErrorCounts(records) {
  // Same buckets as run.mjs's summary (pageerror/console prefixes);
  // the extension additionally folds unhandledrejection into page
  // errors — in the page both are uncaught faults.
  const pageErrors = records.reduce(
    (n, r) => n + r.errors.filter((e) => e.startsWith('pageerror') || e.startsWith('unhandledrejection')).length,
    0,
  );
  const consoleErrors = records.reduce(
    (n, r) => n + r.errors.filter((e) => e.startsWith('console')).length,
    0,
  );
  return { pageErrors, consoleErrors };
}

function buildWalkReportMd(diffs) {
  const walk = state.walk;
  const records = walk.records;
  const catalog = state.catalog;
  const stamp = state.catalogStamp ?? {};
  const appLabel = walk.appLabel ?? catalog?.app ?? 'Email Builder';
  const b = APP_BINDINGS[walk.appId] ?? APP_BINDINGS['email-builder'];
  const extVersion = chrome.runtime.getManifest().version;
  const today = new Date(walk.startedAt ?? Date.now()).toLocaleDateString('en-CA');
  const counts = walkCounts(records);
  const { pageErrors, consoleErrors } = walkErrorCounts(records);
  const safetyLine = walk.settings?.autoRun
    ? `AUTO MODE (user opt-in, cap ${walk.settings.autoCapBuzz} Buzz/card): Send and in-cap price confirms clicked by the runner; over-cap cards fell back to the user's own click; consent walls still stopped the run (§5).`
    : 'Send/confirm never clicked by the runner; spends only via the user’s own clicks (spec §5).';
  const catalogLine =
    `Step catalog ${catalog?.app ?? 'email-builder'} v${catalog?.version ?? '?'} · sha256 ${walk.catalogHash ?? '(unknown)'}` +
    (stamp.syncedAt ? ` (${stamp.source ?? 'tools/walk/steps.json'} copy, synced ${stamp.syncedAt})` : '') +
    '.';

  let targetHost = null;
  try { targetHost = new URL(walk.targetUrl).hostname; } catch { /* stays null */ }
  const isMock = targetHost === 'localhost' || targetHost === '127.0.0.1';

  const lines = [];
  lines.push(`# ${appLabel} walk — ${today}`);
  lines.push('');
  if (isMock) {
    lines.push(
      `Mock-host harness at ${new URL(walk.targetUrl).origin} — a panel rehearsal of the ${appLabel} catalog (mock Buzz only; no real spend). ` +
        `${catalogLine} ${safetyLine}`,
    );
  } else {
    lines.push(
      `Live ${appLabel} at ${walk.targetUrl}${walk.frameId != null ? ` (app frame ${walk.frameId})` : ''}, ` +
        `driven in the signed-in browser by Toil-Killer extension v${extVersion}. ${catalogLine} ${safetyLine}`,
    );
  }
  lines.push('');
  lines.push(
    `**Settings (§8.7):** allow scratch ${b.scratchNounPlural} ${walk.settings?.allowScratch ? 'ON' : 'OFF'} · ` +
      `step groups this run: ${(walk.settings?.groups ?? []).join(', ') || '(none)'} · ` +
      (walk.settings?.liveBranchForced
        ? 'live-mode assertions FORCED on the mock harness (proof override — live origins always use them) · '
        : '') +
      (walk.settings?.autoRun
        ? `AUTO MODE ON (cap ${walk.settings.autoCapBuzz} Buzz/card — Send + in-cap confirms ran without waiting) · `
        : 'auto mode OFF (price/send points waited for the user) · ') +
      'toggles persist in chrome.storage.local (extension-local settings only).',
  );
  lines.push('');
  lines.push(
    `**Summary:** ${counts.PASS} passed · ${counts.FAIL} failed · ${counts.SKIPPED} skipped · ` +
      `${counts['LIVE-LIMITED']} live-limited · ${counts['AWAITING-USER-ENDED']} awaiting-user-ended · ` +
      `${pageErrors} page errors · ${consoleErrors} console errors across ${records.length} steps.`,
  );
  lines.push('');
  lines.push('| # | State | Viewport | Status | Screenshot |');
  lines.push('|---|-------|----------|--------|------------|');
  for (const r of records) {
    const shot = walk.shots[r.file];
    lines.push(
      `| ${catalogNumber(r.id)} | ${r.name} | ${catalogStep(r.id)?.viewport ?? ''} | ${liveStatusLabel(r)} | ` +
        `${shot ? `[${r.file}](${r.file})` : r.file} |`,
    );
  }
  lines.push('');
  for (const r of records) {
    const label = liveStatusLabel(r);
    lines.push(`## ${catalogNumber(r.id)}. ${r.name} — ${label}`);
    lines.push('');
    const quotedReason =
      (r.status === 'skipped' || r.status === 'live-limited') &&
      /^(skip-live|live-limited|scratch-only):/.test(r.notes[0] ?? '');
    if (quotedReason) {
      // Mirror run.mjs's "> Mock-limited:" block: the gate reason gets
      // its own quoted line, then checks, then the remaining notes.
      lines.push(`> ${label === 'LIVE-LIMITED' ? 'Live-limited' : 'Skipped'}: ${r.notes[0]}`, '');
    }
    if (r.wallText) {
      // The consent wall state, verbatim (§5: recorded, never handled).
      lines.push(`> Consent wall (verbatim): “${r.wallText}”`, '');
    }
    for (const c of r.checks) lines.push(`- ${c.ok ? '✓' : '✗ FAIL'} ${c.label}`);
    for (const n of quotedReason ? r.notes.slice(1) : r.notes) lines.push(`- _${n}_`);
    if (r.viewport) lines.push(`- _viewport ${r.viewport}_`);
    if (r.errors.length) {
      lines.push('', '**Errors seen during this state:**');
      for (const e of r.errors) lines.push(`- \`${e}\``);
    }
    if (walk.shots[r.file]) {
      lines.push(
        '',
        `- _screenshot ${r.file} (~${Math.round((r.shotBytes ?? 0) / 1024)} KB)_`,
        '',
        `![${r.name}](${r.file})`,
        '',
      );
    } else {
      lines.push('');
    }
  }

  lines.push('## Run events');
  lines.push('');
  const awaitEvents = (walk.events ?? []).filter((e) => e.kind === 'awaiting-user');
  const autoEvents = (walk.events ?? []).filter((e) => e.kind === 'auto-confirm');
  for (const e of autoEvents) {
    lines.push(`- auto-confirm — step \`${e.stepId}\`: ${e.detail} → ${e.outcome ?? '(no outcome recorded)'}`);
  }
  if (awaitEvents.length) {
    for (const e of awaitEvents) {
      lines.push(`- awaiting-user — step \`${e.stepId}\`: ${e.detail} → ${e.outcome ?? '(no outcome recorded)'}`);
    }
  } else if (!autoEvents.length) {
    lines.push('Awaiting-user events: none — no step reached a price/send point in this run.');
  }
  lines.push('');

  // §5 containment, stated plainly: what scratch existed, and proof it
  // is gone — or a loud naming of what is left behind.
  lines.push(`## Scratch ${b.scratchNounPlural} (spec §5)`);
  lines.push('');
  if (walk.scratch?.id) {
    lines.push(`- created this run: “${walk.scratch.name}” (id ${walk.scratch.id}) — the only ${b.scratchNoun} stateful steps could touch.`);
    if (walk.cleanup) {
      for (const name of walk.cleanup.deleted ?? []) lines.push(`- cleanup: deleted “${name}”.`);
      for (const name of walk.cleanup.alreadyAbsent ?? []) {
        lines.push(`- cleanup: “${name}” was already absent (nothing left behind).`);
      }
      for (const f of walk.cleanup.failed ?? []) {
        lines.push(`- ⚠ LEFTOVER SCRATCH ${b.scratchNoun.toUpperCase()} — cleanup FAILED for “${f.name}” (id ${f.id}): ${f.error} — delete it by hand.`);
      }
      if (!(walk.cleanup.failed ?? []).length) lines.push(`- cleanup: no scratch ${b.scratchNounPlural} remain.`);
    } else {
      lines.push(`- ⚠ cleanup did not run (panel closed early?) — check for the scratch ${b.scratchNoun} above and delete it by hand.`);
    }
  } else if (walk.settings?.allowScratch === false) {
    lines.push(`None — the “allow scratch ${b.scratchNounPlural}” toggle was OFF, so no scratch ${b.scratchNoun} was created and the run stayed read-only.`);
  } else {
    lines.push('None created — no stateful (scratch-only) step ran in this run.');
  }
  lines.push('');

  if (walk.halt) {
    lines.push('## Run stopped early');
    lines.push('');
    lines.push(
      `Stopped after ${walk.halt.index} of ${walk.selectedCount ?? records.length} selected steps — ${walk.halt.reason} ` +
        'Steps after that point were never dispatched; they are marked SKIPPED above with this reason.',
    );
    lines.push('');
  }

  if (diffs) {
    lines.push('## Visual diff vs baseline', '');
    lines.push('| State | Triage | Pixels changed |');
    lines.push('|-------|--------|----------------|');
    for (const d of diffs) {
      lines.push(`| ${d.file} | ${d.state} | ${d.pct === null ? '—' : `${d.pct.toFixed(2)}%`} |`);
    }
    lines.push(
      '',
      'CHANGED (over the 2% threshold) is a triage flag, not a verdict: identical-code runs show ' +
        '~0–1.7% raster jitter (scroll positions, caret, sub-pixel text), while real layout/copy ' +
        'changes move well past 2% — the taste strip is where the call gets made.',
      '',
      'Side-by-side: [taste-strip.html](taste-strip.html).',
      '',
    );
  } else {
    lines.push(
      '## Visual diff vs baseline',
      '',
      'No baseline imported — use “Save this run as baseline” in the panel (or import a mock-walk ' +
        'baseline folder’s PNGs), then re-download the bundle for the side-by-side taste strip. ' +
        'taste-strip.html says the same until then.',
      '',
    );
  }
  return lines.join('\n');
}

function buildWalkStripHtml() {
  const walk = state.walk;
  const today = new Date(walk.startedAt ?? Date.now()).toLocaleDateString('en-CA');
  const counts = walkCounts(walk.records);
  const { pageErrors, consoleErrors } = walkErrorCounts(walk.records);
  // Only states with a screenshot get a figure — the mock walk always
  // has one; a skipped live state must not ship a broken <img>.
  const figures = walk.records
    .filter((r) => walk.shots[r.file])
    .map(
      (r) =>
        `<figure><img src="${r.file}" alt="${r.name}"><figcaption>` +
        `<strong>${catalogNumber(r.id)}. ${r.name}</strong> · ${catalogStep(r.id)?.viewport ?? ''} · ${liveStatusLabel(r)}</figcaption></figure>`,
    )
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${walk.appLabel ?? 'Email Builder'} walk ${today}</title>
<style>body{background:#101113;color:#e6e6e6;font-family:system-ui;margin:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}
figure{margin:0;background:#1a1b1e;border:1px solid #333;border-radius:8px;padding:8px}
img{width:100%;display:block;border-radius:4px}figcaption{padding-top:8px;font-size:13px}</style>
<h1>${walk.appLabel ?? 'Email Builder'} walk — ${today}</h1>
<p>${counts.PASS} passed · ${counts.FAIL} failed · ${counts.SKIPPED} skipped · ${counts['LIVE-LIMITED']} live-limited · ${counts['AWAITING-USER-ENDED']} awaiting-user-ended · ${pageErrors} page errors · ${consoleErrors} console errors</p>
<div class="grid">${figures}</div>
`;
}

function buildWalkTasteStripHtml(diffs) {
  const walk = state.walk;
  const today = new Date(walk.startedAt ?? Date.now()).toLocaleDateString('en-CA');
  const head = `<!doctype html><meta charset="utf-8"><title>${walk.appLabel ?? 'Email Builder'} taste strip ${today}</title>
<style>body{background:#101113;color:#e6e6e6;font-family:system-ui;margin:24px}
table{border-collapse:collapse;width:100%}td{border:1px solid #333;padding:8px;vertical-align:top;width:33%}
img{width:100%;display:block}</style>
<h1>${walk.appLabel ?? 'Email Builder'} taste strip — ${today} (baseline vs now)</h1>
`;
  if (!diffs) {
    return (
      head +
      '<p>no baseline imported — import a baseline (the mock walk’s <code>tools/walk/baseline/</code> ' +
      'PNGs, or a previous run saved as a baseline) and re-download the bundle. ' +
      'No comparison is claimed until one exists.</p>\n'
    );
  }
  const byFile = new Map(diffs.map((d) => [d.file, d]));
  const rows = walk.records
    .filter((r) => walk.shots[r.file])
    .map((r) => {
      const d = byFile.get(r.file) ?? { state: 'new', pct: null };
      const badge =
        d.state === 'new'
          ? '<span style="color:#fab005">NEW STATE</span>'
          : d.state === 'changed'
            ? `<span style="color:#ff8787">CHANGED ${d.pct?.toFixed(2)}%</span>`
            : '<span style="color:#69db7c">unchanged</span>';
      const oldImg =
        d.state === 'new' ? '<em>no baseline</em>' : `<img src="baseline/${r.file}" alt="baseline ${r.name}">`;
      return `<tr><td><strong>${catalogNumber(r.id)}. ${r.name}</strong><br>${badge}</td><td>${oldImg}</td><td><img src="${r.file}" alt="current ${r.name}"></td></tr>`;
    })
    .join('\n');
  return (
    head +
    `<table><tr><td><strong>State</strong></td><td><strong>Baseline</strong></td><td><strong>Current</strong></td></tr>\n${rows}</table>\n`
  );
}

/** Assemble the whole bundle in memory (no downloads yet). */
async function collectWalkBundle() {
  if (!state.walk) return null;
  const diffs = await computeDiffs();
  const reportMd = buildWalkReportMd(diffs);
  const stripHtml = buildWalkStripHtml();
  const tasteHtml = buildWalkTasteStripHtml(diffs);
  const files = [
    { path: 'report.md', kind: 'text', mime: 'text/markdown', text: reportMd },
    { path: 'strip.html', kind: 'text', mime: 'text/html', text: stripHtml },
    { path: 'taste-strip.html', kind: 'text', mime: 'text/html', text: tasteHtml },
  ];
  for (const r of state.walk.records) {
    const shot = state.walk.shots[r.file];
    if (shot) files.push({ path: r.file, kind: 'png', dataUrl: shot });
  }
  // Mirror the mock walk: baseline copies ride along under baseline/
  // for exactly the states that got compared.
  if (diffs) {
    for (const d of diffs) {
      if (d.state !== 'new' && state.baseline[d.file]) {
        files.push({ path: `baseline/${d.file}`, kind: 'png', dataUrl: state.baseline[d.file] });
      }
    }
  }
  return { files, diffs, reportMd, stripHtml, tasteHtml };
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = /data:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] ?? 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function downloadBundleFiles(files, prefix) {
  const ids = [];
  for (const f of files) {
    const blob =
      f.kind === 'text'
        ? new Blob([f.text], { type: f.mime ?? 'text/plain' })
        : dataUrlToBlob(f.dataUrl);
    const url = URL.createObjectURL(blob);
    try {
      ids.push(
        await chrome.downloads.download({
          url,
          filename: `${prefix}/${f.path}`,
          conflictAction: 'overwrite',
        }),
      );
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    }
  }
  return ids;
}

function defaultBundleFolder() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `toil-killer/walk-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function bundleFolderValue() {
  return $('bundleFolder').value.trim().replace(/^\/+|\/+$/g, '') || defaultBundleFolder();
}

async function downloadWalkBundle() {
  const bundle = await collectWalkBundle();
  if (!bundle) {
    $('bundleStatus').textContent = 'run a walk first — there is nothing to bundle yet.';
    return [];
  }
  const prefix = bundleFolderValue();
  const ids = await downloadBundleFiles(bundle.files, prefix);
  $('bundleStatus').textContent = `⬇ ${ids.length} files → Downloads/${prefix}/`;
  return ids;
}

// Ship to homelab — direct to S3 (homelab-infra #961, live
// 2026-10-07). With S3 settings saved (options page), the panel PUTs
// each bundle file to the MinIO bucket with a SigV4 signature and an
// x-amz-checksum-sha256 the server verifies — the key is write-only
// (PutObject on that bucket, no read-back). Without settings, the
// Downloads + clipboard-prompt fallback below is unchanged.
const S3_DEFAULTS = { endpoint: 'https://toil-s3.zacx.dev', bucket: 'toil-killer-runs', accessKey: 'toil-killer-svc' };

async function loadS3Config() {
  try {
    const got = await chrome.storage.local.get('tkS3V1');
    const cfg = got?.tkS3V1;
    if (cfg && typeof cfg === 'object' && cfg.secretKey) {
      return {
        endpoint: (cfg.endpoint || S3_DEFAULTS.endpoint).replace(/\/+$/, ''),
        bucket: cfg.bucket || S3_DEFAULTS.bucket,
        accessKey: cfg.accessKey || S3_DEFAULTS.accessKey,
        secretKey: cfg.secretKey,
      };
    }
  } catch { /* storage unavailable */ }
  return null;
}

const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function hmacSha256(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Path-style SigV4 PUT. fetch never sends Expect: 100-continue (the
// Cloudflare 502 trap in #961) and the panel page is CORS-exempt for
// host-permitted origins, so no bucket CORS is needed.
async function s3Put(cfg, key, bytes, mime) {
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) throw new Error(`unsafe object key refused: ${key}`);
  const shaHex = await sha256Hex(bytes);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${cfg.bucket}/${key}`;
  const signedHeaders = 'host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-checksum-sha256:${bytesToBase64(hexToBytes(shaHex))}\n` +
    `x-amz-content-sha256:${shaHex}\n` +
    `x-amz-date:${amzDate}\n`;
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, shaHex].join('\n');
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(new TextEncoder().encode(canonicalRequest))].join('\n');
  const enc = new TextEncoder();
  let k = await hmacSha256(enc.encode(`AWS4${cfg.secretKey}`), dateStamp);
  k = await hmacSha256(k, 'us-east-1');
  k = await hmacSha256(k, 's3');
  k = await hmacSha256(k, 'aws4_request');
  const signature = toHex(await hmacSha256(k, stringToSign));
  const res = await fetch(`${cfg.endpoint}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': shaHex,
      'x-amz-checksum-sha256': bytesToBase64(hexToBytes(shaHex)),
      'Content-Type': mime || 'application/octet-stream',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`PUT ${key} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { key, sha256: shaHex };
}

async function shipToHomelab() {
  const bundle = await collectWalkBundle();
  if (!bundle) {
    $('shipStatus').textContent = 'Run a walk first.';
    return [];
  }
  const prefix = bundleFolderValue();
  const counts = walkCounts(state.walk.records);
  const fileBytes = [];
  const fileMeta = [];
  for (const f of bundle.files) {
    let buf;
    if (f.kind === 'text') buf = new TextEncoder().encode(f.text);
    else buf = Uint8Array.from(atob(f.dataUrl.slice(f.dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    fileBytes.push({ f, buf });
    fileMeta.push({ path: f.path, bytes: buf.byteLength, sha256: await sha256Hex(buf) });
  }
  const s3 = await loadS3Config();
  const manifest = {
    kind: 'toil-killer-ship',
    version: 1,
    createdAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    catalogHash: state.catalogHash,
    targetUrl: state.walk.targetUrl,
    counts,
    halt: state.walk.halt ?? null,
    destination: s3
      ? {
          type: 's3',
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          repoPath: `${prefix}/`,
          transport: 'direct SigV4 PUT from the extension (write-only scoped key, homelab-infra #961)',
        }
      : {
          cluster: 'homelab',
          namespace: 'muse',
          bridge: 'muse-bridge (read-only status, via Muse)',
          repo: 'private homelab infra repo (via Muse)',
          repoPath: `toil-killer-runs/${prefix}/`,
          transport: 'GitHub Contents API via Muse — Downloads fallback (no S3 secret saved)',
        },
    files: fileMeta,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  if (s3) {
    // Ship directly: files first, manifest LAST (its hashes vouch
    // for everything before it), server-checked per object.
    const total = fileBytes.length + 1;
    const done = [];
    for (let i = 0; i < fileBytes.length; i++) {
      const { f, buf } = fileBytes[i];
      $('shipStatus').textContent = `🚀 S3 ${i + 1}/${total} ${f.path}…`;
      done.push(await s3Put(s3, `${prefix}/${f.path}`, buf, f.mime || 'application/octet-stream'));
    }
    $('shipStatus').textContent = `🚀 S3 ${total}/${total} ship-manifest.json…`;
    done.push(await s3Put(s3, `${prefix}/ship-manifest.json`, new TextEncoder().encode(manifestText), 'application/json'));
    $('shipStatus').textContent = `🚀 S3 ✓ ${s3.bucket}/${prefix}/ — ${done.length} objects, hashes server-checked`;
    return done.map((d) => d.key);
  }
  const files = [
    ...bundle.files,
    { path: 'ship-manifest.json', kind: 'text', mime: 'application/json', text: manifestText },
  ];
  const ids = await downloadBundleFiles(files, prefix);
  const prompt =
    `Ship this Toil-Killer run to homelab: Downloads/${prefix}/ — push report.md, ` +
    `ship-manifest.json + PNGs to the private homelab infra repo at toil-killer-runs/${prefix}/, ` +
    'verify the muse namespace via muse-bridge, then grade §8.8.';
  let copied = false;
  try { await navigator.clipboard.writeText(prompt); copied = true; } catch { /* clipboard unavailable */ }
  $('shipStatus').textContent =
    `🚀 ${ids.length} files → Downloads/${prefix}/` + (copied ? ' · prompt copied — paste to Muse' : ' (no S3 secret saved — see extension options)');
  return ids;
}

async function saveWalkBaseline() {
  const walk = state.walk;
  if (!walk || walk.status !== 'done') {
    $('bundleStatus').textContent = 'finish a walk first — a baseline is a finished run’s screenshots.';
    return [];
  }
  const names = [];
  const files = [];
  for (const r of walk.records) {
    const shot = walk.shots[r.file];
    if (!shot) continue;
    files.push({ path: r.file, kind: 'png', dataUrl: shot });
    names.push(r.file);
  }
  if (!names.length) {
    $('bundleStatus').textContent = 'this run produced no screenshots — nothing to save as a baseline.';
    return [];
  }
  // Same manifest shape as tools/walk/baseline/manifest.json.
  files.push({
    path: 'manifest.json',
    kind: 'text',
    mime: 'application/json',
    text: JSON.stringify({ createdAt: new Date().toISOString(), base: walk.targetUrl, files: names }, null, 2),
  });
  const folder = `${bundleFolderValue()}-baseline`;
  const ids = await downloadBundleFiles(files, folder);
  $('bundleStatus').textContent = `⬇ Baseline: ${ids.length} files → Downloads/${folder}/`;
  return ids;
}

function readFileAsDataUrl(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

function setBaselineMap(map, source = 'programmatic') {
  state.baseline = { ...(map ?? {}) };
  const names = Object.keys(state.baseline);
  const catalogFiles = new Set(state.catalog?.steps.map((s) => s.file) ?? []);
  const matched = names.filter((n) => catalogFiles.has(n)).length;
  state.baselineMeta = { count: names.length, matched, importedAt: new Date().toISOString(), source };
  $('baselineStatus').textContent = names.length
    ? `Baseline: ${names.length} PNGs · ${matched} matched`
    : 'No PNGs selected';
  return state.baselineMeta;
}

async function importBaselineFiles(fileList) {
  const map = {};
  for (const f of [...fileList]) {
    if (!/\.png$/i.test(f.name)) continue;
    map[f.name] = await readFileAsDataUrl(f);
  }
  setBaselineMap(map, 'file picker');
  return Object.keys(map).length;
}

$('btnBundle').addEventListener('click', () => {
  downloadWalkBundle().catch((err) => {
    $('bundleStatus').textContent = `Bundle failed: ${err?.message ?? err}`;
  });
});
$('btnShip').addEventListener('click', () => {
  shipToHomelab().catch((err) => {
    $('shipStatus').textContent = `Ship failed: ${err?.message ?? err}`;
  });
});
$('btnSaveBaseline').addEventListener('click', () => {
  saveWalkBaseline().catch((err) => {
    $('bundleStatus').textContent = `baseline save failed: ${err?.message ?? err}`;
  });
});
$('btnImportBaseline').addEventListener('click', () => $('baselineFiles').click());
$('baselineFiles').addEventListener('change', async (e) => {
  if (e.target.files?.length) await importBaselineFiles(e.target.files);
  e.target.value = '';
});

// Programmatic surface: the headless proof drives the same code the
// buttons do (assertion substrate = generated file contents).
window.__tkWalkReport = {
  buildFiles: collectWalkBundle,
  downloadBundle: downloadWalkBundle,
  shipToHomelab,
  saveBaseline: saveWalkBaseline,
  importBaselineFiles,
  setBaseline: setBaselineMap,
  getBaseline: () => state.baseline,
  labelFor: liveStatusLabel,
};

// ---------------------------------------------------------------------
// Diagnostics: the four spike probes (unchanged behavior).
// ---------------------------------------------------------------------

async function runInject() {
  if (!state.tab) return;
  if (state.frames.length === 0) {
    await findAppFrame();
    await refreshFrames();
  }
  if (state.frames.length === 0) {
    setVerdict('verdictInject', 'FAIL — no frames found; reload the app tab', 'fail');
    return;
  }
  setVerdict('verdictInject', 'scanning all frames…', '');
  try {
    // Always scan every known frame: the app may be the top frame
    // (standalone) or a child frame (embedded) — the probe figures
    // out which instead of asking the user.
    const perFrame = {};
    for (const frame of state.frames) {
      try {
        perFrame[`frame ${frame.frameId}`] = await sendProbe(frame.frameId, 'inject');
      } catch (e) {
        perFrame[`frame ${frame.frameId}`] = { note: `probe failed: ${e?.message ?? e}` };
      }
    }
    state.results.inject = perFrame;
    const flag = binding().frameFlag;
    const winner = state.frames.find((f) => perFrame[`frame ${f.frameId}`]?.[flag]);
    if (winner) {
      state.appFrameId = winner.frameId;
      $('frameSelect').value = String(winner.frameId);
      setVerdict('verdictInject', `PASS — app found in frame ${winner.frameId}`, 'pass');
    } else {
      const topEvidence = perFrame['frame 0'];
      const hasChildApp = Array.isArray(topEvidence?.iframes) && topEvidence.iframes.length > 0;
      if (hasChildApp) {
        setVerdict('verdictInject', 'PARTIAL — app frame exists but no probe answered in it; run probe 4 (Diagnose)', 'partial');
      } else {
        setVerdict('verdictInject', 'FAIL', 'fail');
      }
    }
    showJson('outInject', perFrame);
  } catch (err) {
    setVerdict('verdictInject', 'FAIL', 'fail');
    showJson('outInject', `probe message failed: ${err?.message ?? err}`);
  }
}

async function runDrive() {
  if (!state.tab) return;
  // The drive probe types into the Email Builder chat box; it has no
  // Open Datasets equivalent, so say so rather than failing oddly.
  if (state.appId !== 'email-builder') {
    setVerdict('verdictDrive', 'PARTIAL — Email Builder only (no chat box to drive here)', 'partial');
    showJson('outDrive', { note: 'drive probe is Email Builder only; use a walk run for this app.' });
    return;
  }
  setVerdict('verdictDrive', 'finding the app frame…', '');
  try {
    // Auto-detect: standalone apps are the top frame, embedded apps a
    // child frame. Never trust the dropdown — find the frame that
    // actually reports eb-app, then drive there.
    if (state.appFrameId == null) {
      const found = await findAppFrame();
      if (!found) {
        setVerdict('verdictDrive', 'FAIL — no frame sees the app (probe 4 tells the frame-by-frame story)', 'fail');
        showJson('outDrive', state.results.find ?? '(no find evidence)');
        return;
      }
    }
    const frameId = state.appFrameId;
    setVerdict('verdictDrive', `driving frame ${frameId}…`, '');
    const res = await sendProbe(frameId, 'drive');
    res.frameId = frameId;
    state.results.drive = res;
    let verdict = 'FAIL';
    let cls = 'fail';
    if (res?.typedText === PROBE_TEXT && res?.cleared) {
      if (res?.sendButton?.found) { verdict = 'PASS'; cls = 'pass'; }
      else { verdict = 'PARTIAL — typed and cleared, but eb-send not found'; cls = 'partial'; }
    } else if (res?.typedText === PROBE_TEXT) {
      verdict = 'PARTIAL — typed, but clear did not verify';
      cls = 'partial';
    }
    setVerdict('verdictDrive', verdict, cls);
    showJson('outDrive', res);
  } catch (err) {
    setVerdict('verdictDrive', 'FAIL', 'fail');
    showJson('outDrive', `probe message failed: ${err?.message ?? err}`);
  }
}

async function runCapture() {
  if (!state.tab) return;
  setVerdict('verdictCapture', 'running…', '');
  const res = await chrome.runtime.sendMessage({ type: 'tk-capture', tabId: state.tab.id });
  if (res?.dataUrl) {
    state.shotDataUrl = res.dataUrl;
    const approxBytes = Math.round((res.dataUrl.length * 3) / 4);
    const pass = res.dataUrl.length > 10_000;
    state.results.capture = { ok: true, dataUrlChars: res.dataUrl.length, approxBytes };
    setVerdict('verdictCapture', pass ? `PASS (~${approxBytes.toLocaleString()} bytes)` : 'PARTIAL — capture returned but looks tiny/blank', pass ? 'pass' : 'partial');
    showJson('outCapture', state.results.capture);
    const img = $('shotPreview');
    img.src = res.dataUrl;
    img.hidden = false;
    $('btnShot').disabled = false;
  } else {
    // The failure evidence belongs in the report, not just on screen.
    state.results.capture = {
      ok: false,
      error: res?.error ?? 'unknown error (no response from background)',
      tabActive: res?.tabActive ?? null,
      windowFocused: res?.windowFocused ?? null,
    };
    setVerdict('verdictCapture', `FAIL — ${state.results.capture.error}`, 'fail');
    showJson('outCapture', state.results.capture);
  }
}

async function runDiagnose() {
  if (!state.tab) return;
  setVerdict('verdictDiagnose', 'running…', '');
  try {
    // Top frame's inject probe carries the iframe inventory.
    let inventory = null;
    try {
      inventory = await sendProbe(0, 'inject');
    } catch (e) {
      inventory = { note: `top-frame probe failed: ${e?.message ?? e}` };
    }
    const res = await chrome.runtime.sendMessage({ type: 'tk-diagnose', tabId: state.tab.id });
    state.results.diagnose = { inventory, ...(res ?? {}) };

    const attempts = res?.attempts ?? [];
    const anyFound = (e) => Boolean(e?.ebAppFound || e?.dcAppFound);
    const reached = attempts.find((a) => anyFound(a?.viaMessage) || anyFound(a?.viaScripting));
    const childAttempts = attempts.filter((a) => a.frameId !== 0);
    if (reached) {
      const door = anyFound(reached.viaMessage) ? 'resident probe (message)' : 'scripting injection';
      setVerdict('verdictDiagnose', `PASS — app reached in frame ${reached.frameId} via ${door}`, 'pass');
    } else if (childAttempts.length > 0) {
      setVerdict('verdictDiagnose', 'FAIL — child frames inventoried, neither door opened (evidence below says why)', 'fail');
    } else {
      setVerdict('verdictDiagnose', 'PARTIAL — no child frames in this tab yet (app still loading?)', 'partial');
    }
    showJson('outDiagnose', state.results.diagnose);
  } catch (err) {
    setVerdict('verdictDiagnose', 'FAIL', 'fail');
    showJson('outDiagnose', `diagnose failed: ${err?.message ?? err}`);
  }
}

function download(name, href, type) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  if (type === 'blob') setTimeout(() => URL.revokeObjectURL(href), 4_000);
}

function buildReport() {
  const lines = [
    '# Toil-Killer P0 spike report',
    '',
    `- when: ${new Date().toISOString()}`,
    `- tab: ${state.tab?.url ?? '(unknown)'}`,
    `- frames injected: ${state.frames.length}`,
    '',
    '## Verdicts',
    '',
    `- injection: ${$('verdictInject').textContent || '(not run)'}`,
    `- drive: ${$('verdictDrive').textContent || '(not run)'}`,
    `- capture: ${$('verdictCapture').textContent || '(not run)'}`,
    `- diagnose: ${$('verdictDiagnose').textContent || '(not run)'}`,
    '',
    '## Evidence',
    '',
  ];
  for (const [action, evidence] of Object.entries(state.results)) {
    lines.push(`### ${action}`, '', '```json', JSON.stringify(evidence, null, 2), '```', '');
  }
  lines.push(
    '## Safety',
    '',
    'The drive probe typed probe text and cleared it. Send was never clicked;',
    'no price confirm was clicked; no Buzz was spent by this tool.',
    '',
  );
  return lines.join('\n');
}

$('btnFrames').addEventListener('click', refreshFrames);
$('btnInject').addEventListener('click', runInject);
$('btnDrive').addEventListener('click', runDrive);
$('btnCapture').addEventListener('click', runCapture);
$('btnDiagnose').addEventListener('click', runDiagnose);
$('btnShot').addEventListener('click', () => {
  if (state.shotDataUrl) download('toil-killer-spike-shot.png', state.shotDataUrl);
});
$('btnReport').addEventListener('click', () => {
  const blob = new Blob([buildReport()], { type: 'text/markdown' });
  download('toil-killer-spike-report.md', URL.createObjectURL(blob), 'blob');
});
$('optScratch').addEventListener('change', () => {
  state.settings.allowScratchDrafts = $('optScratch').checked;
  persistSettings();
});
$('optLiveBranch').addEventListener('change', () => {
  state.liveBranch = $('optLiveBranch').checked;
});
for (const id of ['optAuto', 'optAutoCap']) {
  $(id).addEventListener('change', () => {
    Object.assign(state.settings, autoSettings());
    persistSettings();
  });
}

// App picker: switching bindings mid-run is refused (a bundle must
// never mix two apps); otherwise the outgoing group's selections are
// stashed, any finished walk is cleared so Bundle/Ship cannot ship
// the wrong app, and the new catalog + targets load.
$('appSelect').addEventListener('change', async () => {
  const next = $('appSelect').value;
  if (state.walkRunning) {
    $('appSelect').value = state.appId;
    setVerdict('walkStatus', 'finish the run before switching apps', 'fail');
    return;
  }
  if (!APP_BINDINGS[next] || next === state.appId) return;
  state.settings.groupsByApp[state.appId] = groupSelection();
  state.appId = next;
  state.settings.appId = next;
  state.settings.groups = state.settings.groupsByApp[next] ?? {};
  state.walk = null;
  window.__tkWalk = null;
  $('stepList').innerHTML = '';
  $('btnBundle').disabled = true;
  $('btnShip').disabled = true;
  $('btnSaveBaseline').disabled = true;
  await persistSettings();
  await loadCatalog();
  await refreshTargets();
});

loadSettings().then(() => {
  loadCatalog();
  refreshTargets();
});

