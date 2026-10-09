// Toil-Killer side panel.
//
// Two halves:
//  1. WALK RUNNER (§8.3–4): loads the shared step catalogs
//     (tools/walk/steps.json + steps-open-datasets.json, synced into
//     this package), verifies each copy against its recorded sha256,
//     and runs selected step groups against a target tab through the
//     in-page executor (content.js). Per-step status streams back
//     live; screenshots come from the background capture service.
//     Priced steps stop at the confirm card and wait for the user's
//     own click — this panel contains no code path that clicks
//     anything in the page; it only sends messages.
//  2. DIAGNOSTICS: the four P0 spike probes, kept as the debugging
//     surface (injection / drive / capture / embedded diagnosis).
//
// Multi-tab (v0.7.0): runs live in per-tab contexts (the registry
// below). Each context owns its tab, app binding, frame, walk,
// scratch, report bundle and status lines, so walks on different
// tabs run concurrently and never see each other's state. The panel
// renders the context of the tab its window is looking at — it
// follows tab activation and window focus; the Target select is the
// manual override and marks each tab's run state. Every executor,
// capture, report and Ship call is pinned to its context's tabId.
// Auto target type (v0.7.1): an idle context's binding follows the
// app root its tab reports whenever the viewed tab changes or a
// navigation completes. A running context is never rebound — the
// tab's current app and the run's app are shown separately when
// they differ. A tab reporting no app root leaves the type
// unselected and Run disabled.

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
  catalogs: {}, // appId -> {catalog, hash, stamp}, loaded once per binding
  baseline: null, // {file: dataUrl} imported baseline PNGs, session only (panel-global: one comparison set)
  baselineMeta: null,
  // persisted toggles (§8.7): the extension's own settings only.
  // groupsByApp keeps each binding's group selection separate.
  settings: { allowScratchDrafts: true, groups: {}, groupsByApp: {}, appId: 'email-builder', autoRun: false, autoCapBuzz: 150, autoShip: false },
  // Proof override (§8.8): force the account-shaped live branches even
  // on the localhost harness, so they are rehearsable headlessly. On a
  // real origin the executor uses live branches regardless.
  liveBranch: false,
};

// ---------------------------------------------------------------------
// Per-tab run contexts (v0.7.0). One context per tab, keyed by tabId:
// target, binding, frame, run state, streamed step lines, status
// lines, bundle folder. Contexts are created lazily and survive tab
// switches; a context whose tab closed stays selectable so its
// report can still be bundled/shipped.
// ---------------------------------------------------------------------

const contexts = new Map(); // tabId -> ctx
let viewTabId = null; // the context the panel currently renders
let myWindowId = null; // the window this panel instance belongs to

function ensureCtx(tab) {
  if (!tab?.id) return null;
  let ctx = contexts.get(tab.id);
  if (!ctx) {
    ctx = {
      tabId: tab.id,
      tab,
      tabGone: false,
      appId: state.settings.appId,
      bindingSource: 'saved', // saved | auto | manual | none
      manualOverride: false, // picker choice holds until the next tab switch/navigation
      detectedAppId: null, // app root the tab itself currently reports
      detectedFrameId: null,
      detectedRootTestid: null,
      detectedRule: null, // deterministic both-roots rule, when it was needed
      frames: [],
      appFrameId: null, // auto-detected: the frame that reports the binding's root
      results: {}, // probe action -> evidence (diagnostics, this tab)
      shotDataUrl: null,
      // walk run state (this tab only)
      walk: null, // {runId, status, records: [], shots: {file: dataUrl}, settings, scratch, cleanup, ...}
      walkRunning: false,
      walkPaused: false,
      stopRequested: false,
      endAfterStep: false, // an awaiting-user "End run here" was chosen
      pendingDecision: null, // {kind: 'mid-step'|'gate', stepId, resolve}
      progressEvents: 0, // tk-walk-progress count for this context (stale-frame hint)
      liveDetail: {}, // stepId -> streamed lines for the in-flight step (re-render source)
      liveStatus: {}, // stepId -> transient row status while it has no record yet
      consoleHookNote: null,
      abortedReason: null, // set when the tab closed mid-run
      shotRetryPromise: null, // one missing-screenshot retake pass at a time
      // per-context status lines (painted when this context is viewed)
      ui: { walk: '', walkCls: '', bundle: '', ship: '', awaitText: '' },
      shippedRunId: null, // run ID of the last successful Ship on this tab (copyable pointer)
      bundleFolder: '',
    };
    contexts.set(tab.id, ctx);
  } else {
    ctx.tab = tab;
    if (!ctx.tabGone) ctx.tabGone = false;
  }
  return ctx;
}

function viewCtx() {
  return viewTabId != null ? contexts.get(viewTabId) ?? null : null;
}

function bindingFor(ctx) {
  return APP_BINDINGS[ctx?.appId] ?? null;
}

/** Which app this tab itself reports, independent of the binding a
 *  run was started under. Frames are considered top-first, then by
 *  frame id; if one frame reports both roots, registry order wins
 *  (Email Builder before Open Datasets). The winning rule is kept on
 *  the context whenever more than one app root is present, so the
 *  panel can say why this type was chosen. */
function detectTabApp(ctx) {
  const frames = [...(ctx?.frames ?? [])].sort(
    (a, b) => Number(b.isTop ?? false) - Number(a.isTop ?? false) || (a.frameId ?? 0) - (b.frameId ?? 0),
  );
  const candidates = [];
  for (const frame of frames) {
    const appIds = Object.values(APP_BINDINGS)
      .filter((b) => frame?.[b.frameFlag])
      .map((b) => b.id);
    if (appIds.length) candidates.push({ frame, appIds });
  }
  if (!candidates.length) return null;
  const winner = candidates[0];
  const distinct = new Set(candidates.flatMap((c) => c.appIds));
  let rule = null;
  if (distinct.size > 1) {
    rule = winner.appIds.length > 1
      ? 'one frame reported both apps; registry order wins'
      : winner.frame.isTop
        ? 'top frame wins'
        : 'first app frame wins';
  }
  const binding = APP_BINDINGS[winner.appIds[0]];
  return {
    appId: binding.id,
    frameId: winner.frame.frameId ?? null,
    rootTestid: binding.rootTestid,
    rule,
  };
}

/** Follow the tab's own app root for an idle context. A running
 *  context is never rebound: its binding stays the one bound at Run,
 *  while detectedAppId records what the tab shows now. Returns true
 *  when the effective binding changed. */
function applyDetectedBinding(ctx, { followView = false } = {}) {
  if (!ctx || ctx.tabGone) return false;
  const detected = detectTabApp(ctx);
  if (ctx.walkRunning) {
    // While a run is in flight, a navigation's transient frame set
    // (registry cleared, app not yet re-announced) must not erase
    // what the tab last reported; a positive sighting still updates
    // it, so Tab app vs Run app stays truthful.
    if (detected) {
      ctx.detectedAppId = detected.appId;
      ctx.detectedFrameId = detected.frameId;
      ctx.detectedRootTestid = detected.rootTestid;
      ctx.detectedRule = detected.rule;
    }
    return false;
  }
  ctx.detectedAppId = detected?.appId ?? null;
  ctx.detectedFrameId = detected?.frameId ?? null;
  ctx.detectedRootTestid = detected?.rootTestid ?? null;
  ctx.detectedRule = detected?.rule ?? null;
  if (ctx.manualOverride && !followView) return false;
  if (followView) ctx.manualOverride = false;

  const nextAppId = detected?.appId ?? null;
  const changed = ctx.appId !== nextAppId;
  if (changed) {
    ctx.appId = nextAppId;
    ctx.bindingSource = nextAppId ? 'auto' : 'none';
    ctx.results = {};
    ctx.appFrameId = detected?.frameId ?? null;
  } else if (nextAppId) {
    if (ctx.bindingSource !== 'manual') ctx.bindingSource = 'auto';
    ctx.appFrameId = detected.frameId;
  } else {
    ctx.bindingSource = 'none';
    ctx.appFrameId = null;
  }
  return changed;
}

function tabStatusText(ctx) {
  if (ctx.tabGone) {
    return `${ctx.tab?.url ?? '(unknown tab)'} — tab closed; this run's report is still here.`;
  }
  const url = ctx.tab?.url ?? '(no URL)';
  const detected = APP_BINDINGS[ctx.detectedAppId] ?? null;
  const runBinding = APP_BINDINGS[ctx.walk?.appId] ?? null;
  if (runBinding && ctx.detectedAppId !== runBinding.id) {
    const tabApp = detected ? detected.label : 'no app';
    return `${url} · Tab app: ${tabApp} · Run app: ${runBinding.label} (bound at Run)`;
  }
  if (!detected) return `${url} · No app in this tab`;
  const source = ctx.bindingSource === 'manual' ? 'Manual' : 'Auto';
  const rule = ctx.detectedRule ? ` · ${ctx.detectedRule}` : '';
  if (ctx.bindingSource === 'manual' && ctx.appId !== detected.id) {
    return `${url} · Manual: ${bindingFor(ctx)?.label ?? 'none'} · Tab app: ${detected.label} · ${detected.rootTestid}${rule}`;
  }
  return `${url} · ${source}: ${bindingFor(ctx)?.label ?? detected.label} · ${detected.rootTestid}${rule}`;
}

const SETTINGS_KEY = 'tkSettingsV1';

// ---------------------------------------------------------------------
// Persisted toggles (§8.7): chrome.storage.local, extension-local only.
// Defaults are the safest read of §5: scratch drafts allowed (stateful
// groups cannot run without them), every step group selected.
// Scoping (v0.7.0, deliberate): these toggles stay panel-global and
// persisted exactly as before — each run snapshots them at Run, so
// flipping a toggle never changes a run already in flight on any
// tab. What is per-tab is run state, not settings.
// ---------------------------------------------------------------------

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
        autoShip: saved.autoShip === true,
      };
    }
  } catch {
    /* storage unavailable — session defaults stand */
  }
  $('appSelect').value = state.settings.appId;
  $('optScratch').checked = state.settings.allowScratchDrafts;
  $('optAuto').checked = state.settings.autoRun;
  $('optAutoCap').value = String(state.settings.autoCapBuzz);
  $('optAutoShip').checked = state.settings.autoShip;
}

function autoSettings() {
  const cap = Number.parseFloat($('optAutoCap').value);
  return {
    autoRun: $('optAuto').checked === true,
    autoCapBuzz: Number.isFinite(cap) && cap >= 0 ? cap : 0,
    // Auto-ship (v0.7.9): read with the other Run-time settings so the
    // walk snapshot carries the deal the run actually executes under.
    autoShip: $('optAutoShip').checked === true,
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

// Per-context status lines: recorded on the context always, painted
// only while that context is the viewed one.
function setWalkStatus(ctx, text, cls) {
  ctx.ui.walk = text;
  if (cls !== undefined) ctx.ui.walkCls = cls;
  if (ctx === viewCtx()) paintWalkStatus(ctx);
}
function appendWalkStatus(ctx, text) {
  ctx.ui.walk = (ctx.ui.walk ?? '') + text;
  if (ctx === viewCtx()) paintWalkStatus(ctx);
}
function paintWalkStatus(ctx) {
  const el = $('walkStatus');
  el.textContent = ctx.ui.walk ?? '';
  el.className = `verdict ${ctx.ui.walkCls ?? ''}`;
}
function setBundleStatus(ctx, text) {
  ctx.ui.bundle = text;
  if (ctx === viewCtx()) $('bundleStatus').textContent = text;
}
function setShipStatus(ctx, text) {
  ctx.ui.ship = text;
  if (ctx === viewCtx()) $('shipStatus').textContent = text;
}

// Ship pointer (v0.7.3): after a successful Ship, show the run ID
// (the bundle folder leaf — the ID the homelab bridge serves) with a
// copy button, so the owner can point Muse at the exact run. The
// ID lives on the shipping context only; a new run clears it.
function runIdFromPrefix(prefix) {
  return prefix.split('/').filter(Boolean).pop() ?? '';
}
function setShippedRun(ctx, prefix) {
  ctx.shippedRunId = runIdFromPrefix(prefix);
  paintShipPointer(ctx);
}
function paintShipPointer(ctx) {
  if (!ctx || ctx !== viewCtx()) return;
  const row = $('shipRunRow');
  row.hidden = !ctx.shippedRunId;
  if (ctx.shippedRunId) $('shipRunId').textContent = ctx.shippedRunId;
  $('btnCopyRunId').textContent = '⧉';
}

// ---------------------------------------------------------------------
// Catalogs: load each binding's steps.json + sync stamp once, re-hash
// the copy, display. Drift between the mock runner and this package
// is visible at a glance. The header always describes the VIEWED
// context's binding.
// ---------------------------------------------------------------------

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function catalogOf(appId) {
  return state.catalogs[appId] ?? null;
}

async function loadCatalogFor(appId) {
  if (!APP_BINDINGS[appId]) {
    paintCatalog();
    return null;
  }
  if (state.catalogs[appId]) {
    paintCatalog();
    return state.catalogs[appId];
  }
  const b = APP_BINDINGS[appId] ?? APP_BINDINGS['email-builder'];
  try {
    const [stepsBuf, stamp] = await Promise.all([
      fetch(chrome.runtime.getURL(b.catalog)).then((r) => r.arrayBuffer()),
      fetch(chrome.runtime.getURL(b.stamp)).then((r) => r.json()),
    ]);
    const catalog = JSON.parse(new TextDecoder().decode(stepsBuf));
    const hash = await sha256Hex(stepsBuf);
    state.catalogs[b.id] = { catalog, hash, stamp };
  } catch (err) {
    const ctx = viewCtx();
    if (ctx && ctx.appId === b.id) {
      $('catalogLine').innerHTML = `<span class="sync-bad">Step catalog failed to load: ${err?.message ?? err} — run npm run steps:sync and reload the extension.</span>`;
    }
    return null;
  }
  paintCatalog();
  return state.catalogs[b.id];
}

function paintCatalog() {
  const ctx = viewCtx();
  if (!ctx) return;
  if (!ctx.appId) {
    $('catalogLine').textContent = 'No app in this tab';
    $('groupList').innerHTML = '';
    return;
  }
  const entry = catalogOf(ctx.appId);
  const line = $('catalogLine');
  if (!entry) {
    line.textContent = 'Loading…';
    return;
  }
  const { catalog, hash, stamp } = entry;
  const b = bindingFor(ctx);
  const inSync = hash === stamp.sha256;
  const extVersion = chrome.runtime.getManifest().version;
  line.title = `${catalog.app} v${catalog.version} · ${stamp.source} · synced ${stamp.syncedAt}`;
  line.innerHTML =
    `${b.label} · ${catalog.steps.length} steps · sha256 ${hash.slice(0, 12)}… · ` +
    (inSync
      ? `<span class="sync-ok">✓ sync</span>`
      : `<span class="sync-bad">⚠ DRIFT ${String(stamp.sha256).slice(0, 12)}… — npm run steps:sync</span>`) +
    ` · extension v${extVersion}`;
  buildGroupList(ctx);
}

function buildGroupList(ctx) {
  const entry = catalogOf(ctx.appId);
  if (!entry) return;
  const { catalog } = entry;
  const appId = ctx.appId;
  const wrap = $('groupList');
  wrap.innerHTML = '';
  for (const group of catalog.groups) {
    const count = catalog.steps.filter((s) => s.group === group).length;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = (state.settings.groupsByApp[appId] ?? {})[group] !== false; // persisted per app (§8.7)
    box.dataset.group = group;
    box.addEventListener('change', () => {
      state.settings.groupsByApp[appId] = groupSelection();
      state.settings.groups = state.settings.groupsByApp[appId];
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

function selectedSteps(ctx) {
  const entry = catalogOf(ctx.appId);
  if (!entry) return [];
  const sel = state.settings.groupsByApp[ctx.appId] ?? {};
  return entry.catalog.steps.filter((s) => sel[s.group] !== false);
}

// ---------------------------------------------------------------------
// Targets + view (v0.7.0): which tab's context the panel renders.
// The view follows the active tab of this panel's window; the Target
// select is the manual override and marks each tab's run state.
// ---------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function framesOf(tabId) {
  const res = await chrome.runtime.sendMessage({ type: 'tk-get-frames', tabId });
  return res?.frames ?? [];
}

/** At-a-glance run state for the Target list: ▶ running / ⏸ action
 *  needed / ✓ done / ✗ done (n failed) / aborted. */
function runMark(ctx) {
  if (!ctx) return '';
  if (ctx.walkRunning) return ctx.pendingDecision ? ' · ⏸ action needed' : ' · ▶ running';
  if (ctx.walk?.status === 'done') {
    const fails = ctx.walk.records.filter((r) => r.status === 'fail').length;
    return fails ? ` · ✗ done (${fails} failed)` : ' · ✓ done';
  }
  if (ctx.walk) return ' · (run ended)';
  return '';
}

function tabOptionText(ctx) {
  const found = (ctx.frames ?? []).find((f) => f.appFound);
  const mark = found ? `● ${found.appRootTestid ?? 'app'}` : '○ no app';
  return `${mark} · ${ctx.tab?.url ?? '(no URL)'}${runMark(ctx)}${ctx.tabGone ? ' · (tab closed)' : ''}`;
}

function paintTargetOptions() {
  const sel = $('targetSelect');
  sel.innerHTML = '';
  for (const ctx of contexts.values()) {
    if (!ctx.tabGone || ctx.walk) {
      const opt = document.createElement('option');
      opt.value = String(ctx.tabId);
      opt.textContent = tabOptionText(ctx);
      sel.appendChild(opt);
    }
  }
  if (viewTabId != null && contexts.has(viewTabId)) sel.value = String(viewTabId);
}

async function refreshTargets({ followView = true } = {}) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith('chrome-extension://')) continue;
    const ctx = ensureCtx(tab);
    ctx.frames = await framesOf(tab.id);
    applyDetectedBinding(ctx);
  }
  // Initial view only: the window's active tab wins; before any
  // interaction, prefer a tab that actually shows an app (a freshly
  // opened panel page itself can be the "active tab" headlessly).
  if (viewTabId == null || !contexts.has(viewTabId)) {
    const active = await activeTab();
    const live = [...contexts.values()].filter((c) => !c.tabGone);
    const pick =
      live.find((c) => c.tabId === active?.id) ??
      live.find((c) => (c.frames ?? []).some((f) => f.appFound)) ??
      live[0];
    if (pick) viewTabId = pick.tabId;
  }
  paintTargetOptions();
  if (viewTabId != null) await setView(viewTabId, { followView });
}

/** Render one context into the whole panel. Rendering never touches
 *  run state; switching views mid-run is a pure repaint. */
async function setView(tabId, { skipFrameRefresh = false, followView = false } = {}) {
  const ctx = contexts.get(tabId);
  if (!ctx) return;
  viewTabId = tabId;
  if (!ctx.tabGone) {
    ctx.frames = await framesOf(ctx.tabId).catch(() => ctx.frames);
    applyDetectedBinding(ctx, { followView });
  }
  if (ctx.appId) {
    state.settings.appId = ctx.appId;
    state.settings.groups = state.settings.groupsByApp[ctx.appId] ?? {};
    void persistSettings();
  }
  window.__tkWalk = ctx.walk ?? null;
  $('appSelect').value = ctx.appId ?? '';
  const sel = $('targetSelect');
  if ([...sel.options].some((o) => o.value === String(tabId))) sel.value = String(tabId);
  $('tabInfo').textContent = tabStatusText(ctx);
  await loadCatalogFor(ctx.appId); // paints the header + group list for this app
  paintSteps(ctx);
  paintControls(ctx);
  paintWalkStatus(ctx);
  $('bundleStatus').textContent = ctx.ui.bundle ?? '';
  $('shipStatus').textContent = ctx.ui.ship ?? '';
  paintShipPointer(ctx);
  $('bundleFolder').value = ctx.bundleFolder ?? '';
  paintBanner(ctx);
  paintTargetOptions();
  if (!skipFrameRefresh) {
    const changed = await refreshFrames(ctx);
    // Frame data can arrive after the first paint (notably right
    // after a navigation); if it changed the binding, repaint once
    // with the corrected catalog instead of leaving the old one up.
    if (changed) {
      await setView(tabId, { skipFrameRefresh: true });
      return;
    }
  }
  // Landing on a completed run's tab is the one automatic chance to
  // replace a hidden-tab screenshot absence with a labelled retake.
  void retryMissingScreenshots(ctx);
}

function paintControls(ctx) {
  // Fail closed: a Run needs this tab to report the selected app's
  // root. A no-app tab, or a manual selection the tab does not
  // report, cannot start a walk against the wrong catalog.
  $('btnWalkRun').disabled = ctx.walkRunning || !ctx.appId || ctx.detectedAppId !== ctx.appId;
  $('appSelect').disabled = ctx.walkRunning;
  $('btnWalkPause').disabled = !ctx.walkRunning;
  $('btnWalkStop').disabled = !ctx.walkRunning;
  $('btnWalkPause').textContent = ctx.walkPaused ? 'Resume' : 'Pause';
  const done = ctx.walk?.status === 'done';
  $('btnBundle').disabled = !done;
  $('btnShip').disabled = !done;
  $('btnSaveBaseline').disabled = !done;
}

function paintBanner(ctx) {
  if (ctx !== viewCtx()) return;
  // Keyed on the stored banner text, not the pending decision: the
  // banner is shown before the decision promise is armed (mid-step
  // progress) and after it (the post-step gate), in both orders.
  if (ctx.ui.awaitText) {
    $('awaitText').textContent = ctx.ui.awaitText;
    $('awaitBanner').hidden = false;
  } else {
    $('awaitBanner').hidden = true;
  }
}

function showAwaitBanner(ctx, text) {
  ctx.ui.awaitText = text;
  paintBanner(ctx);
}
function hideAwaitBanner(ctx) {
  ctx.ui.awaitText = '';
  paintBanner(ctx);
}

async function refreshFrames(ctx) {
  if (ctx.tabGone) return false;
  ctx.frames = await framesOf(ctx.tabId);
  const changed = applyDetectedBinding(ctx);
  if (ctx !== viewCtx()) return changed;
  const sel = $('frameSelect');
  sel.innerHTML = '';
  if (ctx.frames.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no injected frames — reload the app tab)';
    sel.appendChild(opt);
    return changed;
  }
  const effectiveAppId = ctx.walkRunning ? (ctx.walk?.appId ?? ctx.appId) : ctx.appId;
  const b = APP_BINDINGS[effectiveAppId] ?? null;
  for (const frame of ctx.frames) {
    const opt = document.createElement('option');
    opt.value = String(frame.frameId);
    const roots = Object.values(APP_BINDINGS)
      .map((x) => `${x.rootTestid} ${frame[x.frameFlag] ? 'seen' : 'not seen'}`)
      .join(' · ');
    opt.textContent = `${frame.isTop ? 'top' : `frame ${frame.frameId}`} · ${b ? `${b.rootTestid} ${frame[b.frameFlag] ? 'seen' : 'not seen'}` : roots} · ${frame.url}`;
    sel.appendChild(opt);
  }
  const appFrame = b ? ctx.frames.find((f) => f[b.frameFlag]) : null;
  const selected = appFrame ?? ctx.frames[0];
  sel.value = String(selected.frameId);
  if (appFrame) ctx.appFrameId = appFrame.frameId;
  else if (!ctx.walkRunning) ctx.appFrameId = null;
  return changed;
}

async function sendProbe(ctx, frameId, action) {
  return chrome.tabs.sendMessage(
    ctx.tabId,
    { type: 'tk-probe-run', action },
    { frameId },
  );
}

// "The app frame" = whichever frame reports the binding's root
// testid. Embedded apps always live in a child iframe; standalone
// apps are the top frame. The background enumerates frames and asks
// each resident probe — nobody picks a frame by hand.
async function findAppFrame(ctx) {
  if (!ctx.appId) return null;
  const res = await chrome.runtime.sendMessage({ type: 'tk-find-app-frame', tabId: ctx.tabId, appId: ctx.appId });
  ctx.results.find = res;
  if (res?.frameId != null) {
    ctx.appFrameId = res.frameId;
    if (ctx === viewCtx()) {
      const sel = $('frameSelect');
      if (sel && [...sel.options].some((o) => o.value === String(res.frameId))) {
        sel.value = String(res.frameId);
      }
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
// tk-walk-step messages; step 1 would sit at RUNNING until the
// dispatch timeout. So before a run's first step: ask the app frame
// for its executor build (stamped on every probe response since
// v0.2.2, read from the frame's own manifest at runtime) and compare
// with this panel's manifest version. Returns null when the build
// matches; otherwise the plain verdict to surface — the run must
// NOT start on a mismatch or on silence.
async function checkExecutorVersion(ctx) {
  const panelVersion = chrome.runtime.getManifest().version;
  const noAnswer =
    `the app frame did not answer the version check (this panel is v${panelVersion}); ` +
    'the app tab may still be holding a Toil-Killer script from before the extension reload. ' +
    'The run did not start. Reload the app tab, then Run again.';
  if (ctx.appFrameId == null) return noAnswer;
  let evidence = null;
  try {
    evidence = await sendProbe(ctx, ctx.appFrameId, 'inject');
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

// --- view following (v0.7.0): the panel shows the run of the tab
// its window is looking at. Other windows' panels follow their own
// windows; this panel never chases a tab in another window.
async function followTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || tab.url.startsWith('chrome-extension://')) return;
  ensureCtx(tab);
  paintTargetOptions();
  await setView(tabId, { followView: true });
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (myWindowId != null && windowId !== myWindowId) return;
  void followTab(tabId);
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (myWindowId != null && windowId !== myWindowId) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab?.id) void followTab(tab.id);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const ctx = contexts.get(tabId);
  if (ctx && tab) ctx.tab = tab;
  if (info.status === 'complete') {
    // Navigations replace the frame set; re-read it so the Target
    // mark (● app / ○ no app) and the idle binding describe the
    // page as it is now. A running context only updates what the
    // tab reports — its Run binding is never silently rebound.
    void (async () => {
      if (ctx) {
        ctx.frames = await framesOf(tabId).catch(() => ctx.frames);
        applyDetectedBinding(ctx, { followView: true });
      }
      paintTargetOptions();
      if (ctx && ctx === viewCtx()) await setView(tabId, { followView: true });
    })();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const ctx = contexts.get(tabId);
  if (!ctx) return;
  ctx.tabGone = true;
  if (ctx.walkRunning) {
    // The run aborts; other tabs' runs are untouched. The executor
    // is gone with the tab, so the stop is best-effort and cleanup
    // reports its own failure honestly at run end.
    ctx.abortedReason =
      'the target tab was closed mid-run — run aborted (§5: nothing past this point was improvised; scratch cleanup was attempted and its outcome is recorded).';
    ctx.stopRequested = true;
    ctx.walkPaused = false;
    control(ctx, 'stop');
    if (ctx.pendingDecision) resolveDecision(ctx, 'end');
  }
  paintTargetOptions();
  if (ctx === viewCtx()) void setView(tabId);
});

// ---------------------------------------------------------------------
// Walk runner (§8.4 protocol): run / pause / stop, per-step status,
// 'needs your click' pause, fail-stop. The panel dispatches one step
// at a time to the in-page executor and renders what streams back.
// Every function here is pinned to one context: a run only ever
// messages its own tab, and one tab's halt/error/close never touches
// another tab's run.
// ---------------------------------------------------------------------

function walkSend(ctx, msg) {
  return chrome.tabs.sendMessage(ctx.tabId, msg, { frameId: ctx.appFrameId });
}

function control(ctx, action, extra = {}) {
  if (ctx.tabGone || ctx.appFrameId == null || !ctx.walk) return;
  chrome.tabs
    .sendMessage(ctx.tabId, { type: 'tk-walk-control', runId: ctx.walk.runId, action, ...extra }, { frameId: ctx.appFrameId })
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

async function installConsoleHook(ctx) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId, frameIds: [ctx.appFrameId] },
      world: 'MAIN',
      func: tkInstallConsoleHook,
    });
  } catch (err) {
    if (!ctx.consoleHookNote) {
      ctx.consoleHookNote = `console-error hook could not be installed (${err?.message ?? err}); page errors are still captured.`;
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

function renderStepRow(ctx, record) {
  if (ctx !== viewCtx()) return;
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

/** (Re)build the viewed context's step list from its walk state:
 *  finished records, the in-flight step's streamed lines, the rest
 *  queued. Pure repaint — safe to call on every view switch. */
function paintSteps(ctx) {
  if (ctx !== viewCtx()) return;
  const list = $('stepList');
  list.innerHTML = '';
  const defs = ctx.walk?.stepDefs ?? [];
  defs.forEach((def, i) => {
    const li = document.createElement('li');
    li.className = 'step-row';
    li.dataset.stepId = def.id;
    li.innerHTML =
      `<span class="st-status st-skipped">QUEUED</span> ` +
      `<span class="st-name">${i + 1} · ${def.name}</span> ` +
      `<span class="st-meta">${def.group} · ${def.liveClass} · ${def.file}</span>` +
      `<div class="st-detail" hidden></div>`;
    list.appendChild(li);
    const record = ctx.walk.records.find((r) => r.id === def.id);
    if (record) {
      renderStepRow(ctx, record);
    } else {
      const live = ctx.liveStatus[def.id];
      if (live) {
        const st = li.querySelector('.st-status');
        st.textContent = live;
        st.className = `st-status ${live === 'AWAITING-USER' ? 'st-awaiting' : 'st-running'}`;
      }
      const detail = ctx.liveDetail[def.id];
      const detailEl = li.querySelector('.st-detail');
      if (detail) {
        detailEl.textContent = detail;
        detailEl.hidden = false;
      }
    }
  });
}

function paintRowStatus(ctx, stepId) {
  if (ctx !== viewCtx()) return;
  const li = document.querySelector(`#stepList [data-step-id="${CSS.escape(stepId)}"]`);
  if (!li) return;
  const live = ctx.liveStatus[stepId];
  if (!live) return;
  const st = li.querySelector('.st-status');
  st.textContent = live;
  st.className = `st-status ${live === 'AWAITING-USER' ? 'st-awaiting' : 'st-running'}`;
}

/** Stream one progress line into the context's buffer (the repaint
 *  source) and, if this context is on screen, into the live DOM. */
function streamLine(ctx, stepId, line) {
  ctx.liveDetail[stepId] = (ctx.liveDetail[stepId] ?? '') + line;
  if (ctx !== viewCtx()) return;
  const detailEl = document.querySelector(`#stepList [data-step-id="${CSS.escape(stepId)}"] .st-detail`);
  if (detailEl) {
    detailEl.hidden = false;
    detailEl.textContent += line;
  }
}

function markRemainingSkipped(ctx, steps, fromIndex, reason) {
  for (let i = fromIndex; i < steps.length; i++) {
    const def = steps[i];
    if (ctx.walk.records.some((r) => r.id === def.id)) continue;
    const record = {
      id: def.id, name: def.name, group: def.group, file: def.file,
      liveClass: def.liveClass, status: 'skipped',
      checks: [], notes: [reason], errors: [], confirmLeftOpen: false, viewport: null,
    };
    ctx.walk.records.push(record);
    renderStepRow(ctx, record);
  }
}

// The awaiting-user decision: one banner serves both the mid-step
// halt (executor is waiting in the page) and the post-step gate
// (a price-confirm card was left open). Buttons resolve it.
function awaitDecision(ctx, kind, stepId) {
  return new Promise((resolve) => {
    ctx.pendingDecision = { kind, stepId, resolve };
  });
}

// Annotate the newest unresolved awaiting-user event for a step with
// the user's choice, so the report can say "card reached → continued /
// ended" verbatim (spec §5 wants those events on the record).
function annotateAwaitEvent(ctx, stepId, outcome) {
  const events = ctx.walk?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].stepId === stepId && events[i].outcome === null) {
      events[i].outcome = outcome;
      return;
    }
  }
}

function resolveDecision(ctx, decision) {
  const pending = ctx.pendingDecision;
  ctx.pendingDecision = null;
  hideAwaitBanner(ctx);
  if (decision === 'end') ctx.endAfterStep = true; // run loop stops after the current step
  if (!pending) return;
  annotateAwaitEvent(
    ctx,
    pending.stepId,
    decision === 'end' ? 'user ended the run' : 'user acted in the page; runner continued',
  );
  if (pending.kind === 'mid-step') {
    control(ctx, 'user-decision', { decision });
    // The executor resolves the step; the run loop sees the record.
    pending.resolve(decision);
  } else {
    pending.resolve(decision);
  }
  paintTargetOptions();
}

// Progress streamed from the executor while a step runs. Routed by
// the SENDER's tab (v0.7.0): a hidden tab's progress lands on its own
// context and is only painted when that context is viewed.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'tk-frame-hello') {
    // App roots boot asynchronously: a frame announces again when
    // its app appears. Fold the sighting into that tab's frame set
    // and re-run detection, so an idle viewed tab auto-selects its
    // type as soon as the root is really there (not only on the
    // next navigation). A running context is never rebound.
    const tabId = sender?.tab?.id;
    const ctx = tabId != null ? contexts.get(tabId) : null;
    if (!ctx || ctx.tabGone) return;
    const frame = {
      frameId: sender.frameId ?? 0,
      url: msg.url,
      isTop: Boolean(msg.isTop),
      ebAppFound: Boolean(msg.ebAppFound),
      dcAppFound: Boolean(msg.dcAppFound),
      appFound: Boolean(msg.ebAppFound || msg.dcAppFound),
      appId: msg.appId ?? null,
      appRootTestid: msg.appRootTestid ?? null,
    };
    const ix = ctx.frames.findIndex((f) => f.frameId === frame.frameId);
    if (ix >= 0) ctx.frames[ix] = frame;
    else ctx.frames.push(frame);
    const wasDetected = ctx.detectedAppId;
    applyDetectedBinding(ctx, { followView: ctx === viewCtx() });
    paintTargetOptions();
    if (ctx === viewCtx() && ctx.detectedAppId !== wasDetected && !ctx.walkRunning) {
      void setView(tabId, { skipFrameRefresh: true, followView: true });
    }
    return;
  }
  if (msg?.type !== 'tk-walk-progress') return;
  const tabId = sender?.tab?.id;
  const ctx = tabId != null ? contexts.get(tabId) : null;
  if (!ctx?.walk || msg.runId !== ctx.walk.runId) return;
  ctx.progressEvents += 1; // v0.2.2: liveness signal for the stale-frame hint
  const stepId = msg.stepId ?? '';
  if (msg.kind === 'check') {
    streamLine(ctx, stepId, `${msg.ok ? '✓' : '✗ FAIL'} ${msg.label}\n`);
  } else if (msg.kind === 'note') {
    streamLine(ctx, stepId, `— ${msg.text}\n`);
  } else if (msg.kind === 'awaiting-user') {
    ctx.liveStatus[stepId] = 'AWAITING-USER';
    paintRowStatus(ctx, stepId);
    // On the run record: the card/send point was reached; the outcome
    // is filled in when the user chooses (annotateAwaitEvent).
    ctx.walk.events.push({
      kind: 'awaiting-user', stepId, detail: msg.reason, outcome: null,
    });
    showAwaitBanner(ctx, `Step “${stepId}”: ${msg.reason}`);
    // The decision is delivered by the banner buttons via
    // resolveDecision('resume'|'end') -> control('user-decision').
    // ctx.pendingDecision is armed here so the buttons know the
    // executor (not the run loop) is waiting.
    ctx.pendingDecision = { kind: 'mid-step', stepId, resolve: () => {} };
    paintTargetOptions();
  } else if (msg.kind === 'user-acted') {
    // v0.2.4: the executor saw the user's act in the page itself and
    // resumed without a Resume click. Retire the banner/decision and
    // record the outcome on the awaiting-user event.
    annotateAwaitEvent(
      ctx,
      stepId,
      'user’s act observed in the page — runner resumed on its own (no Resume click)',
    );
    if (ctx.pendingDecision?.kind === 'mid-step' && ctx.pendingDecision?.stepId === stepId) {
      ctx.pendingDecision = null;
      hideAwaitBanner(ctx);
    }
    ctx.liveStatus[stepId] = 'RUNNING';
    paintRowStatus(ctx, stepId);
    paintTargetOptions();
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

/** Navigate the context's tab to a visit URL and wait for the app frame. */
async function navigateVisit(ctx, url) {
  const tab = await chrome.tabs.get(ctx.tabId);
  ctx.tab = tab;
  if (!sameVisitUrl(tab.url ?? '', url)) {
    await chrome.tabs.update(ctx.tabId, { url });
    // Wait for the load to finish first: mid-navigation, the OLD
    // page's frames can still answer probes, and "found the app" must
    // mean the NEW page's app. (The executor also waits for eb-app
    // itself — this just keeps the panel honest.)
    const loadDeadline = Date.now() + 30_000;
    for (;;) {
      const t = await chrome.tabs.get(ctx.tabId).catch(() => null);
      if (t && t.status === 'complete') break;
      if (Date.now() > loadDeadline) break;
      await sleep(400);
    }
    // Then wait for the content script, i.e. until the app frame answers.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = await findAppFrame(ctx).catch(() => null);
      if (found) break;
      if (Date.now() > deadline) throw new Error(`app frame did not answer after navigating to ${url}`);
      await sleep(500);
    }
  } else {
    await findAppFrame(ctx);
  }
  if (ctx.appFrameId == null) throw new Error(`no frame reports ${bindingFor(ctx).rootTestid} in the target tab`);
  await installConsoleHook(ctx);
  await sleep(300);
}

/** Resolve a catalog visit to a URL for mock rehearsal; null = no nav. */
function visitUrl(ctx, visitDef) {
  const origin = new URL(ctx.tab.url).origin;
  const isMock = origin.includes('localhost') || origin.includes('127.0.0.1');
  if (!isMock) return null; // live: steps run on the tab as-is (§6)
  if (visitDef.setup === 'unseeded') return `${origin}/`;
  if (visitDef.setup === 'query') return `${origin}/?${visitDef.query}`;
  if (visitDef.setup === 'seeded') return ctx.walk?.seededUrl || null;
  return null;
}

async function captureStep(ctx, record) {
  const res = await chrome.runtime.sendMessage({ type: 'tk-capture', tabId: ctx.tabId })
    .catch((err) => ({ error: `capture message failed: ${err?.message ?? err}` }));
  if (res?.dataUrl) {
    ctx.walk.shots[record.file] = res.dataUrl;
    record.shotBytes = Math.round((res.dataUrl.length * 3) / 4);
  } else if (res?.screenshotUnavailable) {
    // Honest absence (v0.7.0): the tab wasn't visible in its window.
    // The step is graded from the DOM alone; the report and the ship
    // manifest name the missing PNG. Never a failure, never another
    // tab's pixels.
    record.shotMissing = res.reason ?? 'tab not visible in its window — screenshot not captured';
    record.notes.push(`screenshot unavailable: ${record.shotMissing}`);
  } else {
    // The mock walk fails a step whose screenshot fails; mirror that.
    record.errors.push(`screenshot failed: ${res?.error ?? 'unknown error'}`);
    if (record.status === 'pass') record.status = 'fail';
  }
}

/**
 * Missing-screenshot retake (v0.7.5): when the panel lands on a tab
 * whose completed run has screenshot absences and that tab is now
 * the visible tab in its window, capture one current-view image for
 * each missing file, failed steps first. This deliberately does not
 * re-drive or recreate a step: the image is later evidence and is
 * labelled with its retake time, while grades stay exactly as run.
 * One pass runs per context at a time, and each missing record is
 * attempted once; a failed attempt updates its missing reason.
 */
async function retryMissingScreenshots(ctx) {
  if (!ctx || ctx.tabGone || ctx.walkRunning || ctx.walk?.status !== 'done') return 0;
  if (ctx.shotRetryPromise) return ctx.shotRetryPromise;
  const missing = ctx.walk.records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.shotMissing && !ctx.walk.shots[record.file] && !record.shotRetakeAttempted)
    .sort((a, b) => Number(b.record.status !== 'fail') - Number(a.record.status !== 'fail') || a.index - b.index)
    .map(({ record }) => record);
  if (!missing.length) return 0;

  ctx.shotRetryPromise = (async () => {
    const tab = await chrome.tabs.get(ctx.tabId).catch(() => null);
    if (!tab?.active) return 0; // a Target-select view alone is not a return to the tab
    let retaken = 0;
    for (const record of missing) {
      record.shotRetakeAttempted = true;
      const res = await chrome.runtime.sendMessage({ type: 'tk-capture', tabId: ctx.tabId })
        .catch((err) => ({ error: `capture message failed: ${err?.message ?? err}` }));
      if (res?.dataUrl) {
        ctx.walk.shots[record.file] = res.dataUrl;
        record.shotBytes = Math.round((res.dataUrl.length * 3) / 4);
        record.shotRetakenAt = new Date().toISOString();
        record.notes.push(
          `screenshot retaken on return to the tab at ${record.shotRetakenAt} — current view; the graded status above is unchanged.`,
        );
        retaken += 1;
      } else {
        record.shotMissing = res?.reason ??
          `retaken screenshot failed: ${res?.error ?? 'unknown error'}`;
      }
    }
    if (retaken) {
      paintSteps(ctx);
      const plural = retaken === 1 ? 'screenshot' : 'screenshots';
      setShipStatus(ctx,
        `↻ ${retaken} ${plural} retaken on return${ctx.shippedRunId ? ' · local until re-ship' : ''}`);
    }
    return retaken;
  })();
  try {
    return await ctx.shotRetryPromise;
  } finally {
    ctx.shotRetryPromise = null;
  }
}

/**
 * Run-end scratch cleanup (§8.6): whatever the run's outcome — done,
 * failed, stopped, fail-stopped — the scratch draft this run created
 * is deleted through the executor, which re-verifies id+name per
 * delete. Failures land on walk.cleanup so the report names the
 * leftovers loudly instead of implying a clean account.
 */
async function runScratchCleanup(ctx) {
  const scratch = ctx.walk?.scratch;
  if (!scratch?.id) return;
  const failAll = (error) => ({
    deleted: [],
    alreadyAbsent: [],
    failed: [{ id: scratch.id, name: scratch.name, error }],
  });
  try {
    await findAppFrame(ctx).catch(() => null);
    if (ctx.appFrameId == null || ctx.tabGone) {
      ctx.walk.cleanup = failAll(`no frame reports ${bindingFor(ctx).rootTestid} at run end — cleanup could not run.`);
      return;
    }
    const res = await walkSend(ctx, { type: 'tk-walk-cleanup', runId: ctx.walk.runId, scratch, appId: ctx.walk.appId ?? ctx.appId });
    ctx.walk.cleanup = res ?? failAll('cleanup returned no answer from the page.');
  } catch (err) {
    ctx.walk.cleanup = failAll(`cleanup message failed: ${err?.message ?? err}`);
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

async function dispatchStep(ctx, def) {
  ctx.liveStatus[def.id] = 'RUNNING';
  paintRowStatus(ctx, def.id);
  // Stale-frame hint (v0.2.2): if the page sends zero progress events
  // for ~20s while this step is still open, the in-page script is
  // probably a pre-reload build that will never answer — annotate
  // the row with the likely cause instead of letting RUNNING sit
  // silently until the timeout.
  const progressBefore = ctx.progressEvents;
  let settled = false;
  const responsePromise = walkSend(ctx, {
    type: 'tk-walk-step', runId: ctx.walk.runId, step: def, appId: ctx.walk.appId ?? ctx.appId,
    allowScratch: ctx.walk.settings?.allowScratch !== false,
    scratch: ctx.walk.scratch ?? null,
    armed: ctx.walk.armed ?? {},
    liveBranch: ctx.walk.liveBranch === true,
    autoRun: ctx.walk.settings?.autoRun === true,
    autoCapBuzz: ctx.walk.settings?.autoCapBuzz ?? 0,
  }).then((res) => { settled = true; return res; });
  responsePromise.catch(() => {}); // the race below is the reader; this only marks it handled
  void (async () => {
    await sleep(20_000);
    if (settled || ctx.progressEvents !== progressBefore || ctx.tabGone) return;
    streamLine(ctx, def.id,
      '⚠ no progress from the page for 20s — a stale in-page script looks likely ' +
      '(the extension was reloaded after this tab loaded). If it never resumes: ' +
      'Stop, reload the app tab, then Run again.\n');
  })();
  // v0.2.4: progress-aware dispatch deadline (see watchDispatchLiveness).
  // Parked awaiting the user → no deadline at all. Otherwise the
  // deadline is 180s of silence, not 180s from dispatch.
  const response = await Promise.race([
    responsePromise,
    watchDispatchLiveness({
      isSettled: () => settled,
      isParked: () =>
        ctx.pendingDecision?.kind === 'mid-step' && ctx.pendingDecision?.stepId === def.id,
      progressCount: () => ctx.progressEvents,
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

async function runWalk(ctx) {
  if (ctx.walkRunning) return;
  if (!ctx.appId || ctx.detectedAppId !== ctx.appId) {
    setWalkStatus(ctx, 'no matching app in this tab — Run is disabled until the tab reports the selected app root', 'fail');
    return;
  }
  const entry = catalogOf(ctx.appId);
  if (!entry) { setWalkStatus(ctx, 'catalog not loaded', 'fail'); return; }
  if (ctx.tabGone || !ctx.tab) { setWalkStatus(ctx, 'no target tab — Refresh targets first', 'fail'); return; }
  const steps = selectedSteps(ctx);
  if (steps.length === 0) { setWalkStatus(ctx, 'no step groups selected', 'fail'); return; }

  // Mock rehearsal pre-flight: seeded visits need their URL up front.
  const origin = new URL(ctx.tab.url).origin;
  const isMock = origin.includes('localhost') || origin.includes('127.0.0.1');
  const seededUrl = $('seededUrl').value.trim(); // read once, while this tab is the viewed one
  if (isMock && !seededUrl) {
    const needsSeed = steps.some((s) => entry.catalog.visits[s.visit]?.setup === 'seeded');
    if (needsSeed) {
      setWalkStatus(ctx, 'seeded visits selected but no seeded URL — paste one above (npm run seed:url)', 'fail');
      return;
    }
  }

  ctx.shippedRunId = null; // a newer run must not inherit the old Ship pointer
  ctx.autoShipDone = false; // auto-ship (v0.7.9) fires once per run
  paintShipPointer(ctx);
  ctx.walkRunning = true;
  ctx.walkPaused = false;
  ctx.stopRequested = false;
  ctx.endAfterStep = false;
  ctx.abortedReason = null;
  ctx.consoleHookNote = null;
  ctx.liveDetail = {};
  ctx.liveStatus = {};
  ctx.walk = {
    runId: `walk-${Date.now()}-${ctx.tabId}`,
    appId: ctx.appId,
    appLabel: bindingFor(ctx).label,
    status: 'running',
    startedAt: new Date().toISOString(),
    targetUrl: ctx.tab.url ?? '(unknown tab URL)',
    tabId: ctx.tabId,
    frameId: ctx.appFrameId,
    selectedCount: steps.length,
    stepDefs: steps,
    seededUrl,
    liveBranch: state.liveBranch === true,
    catalogHash: entry.hash,
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
  if (ctx === viewCtx()) window.__tkWalk = ctx.walk;
  paintSteps(ctx);
  paintControls(ctx);
  paintTargetOptions();
  setWalkStatus(ctx, `running ${steps.length} steps…`, '');

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
      const url = visitUrl(ctx, entry.catalog.visits[run.visit]);
      if (url) await navigateVisit(ctx, url);
      else if (ctx.appFrameId == null) {
        await findAppFrame(ctx);
        if (ctx.appFrameId == null) throw new Error(`no frame reports ${bindingFor(ctx).rootTestid} in the target tab — reload the app tab`);
        await installConsoleHook(ctx);
      }
      for (const def of run.steps) {
        if (ctx.abortedReason) {
          halted = { index: flatIndex, reason: ctx.abortedReason };
          break;
        }
        if (ctx.stopRequested) {
          halted = { index: flatIndex, reason: 'run stopped by you.' };
          break;
        }
        while (ctx.walkPaused && !ctx.stopRequested && !ctx.tabGone) await sleep(200);
        if (ctx.abortedReason) {
          halted = { index: flatIndex, reason: ctx.abortedReason };
          break;
        }
        if (ctx.stopRequested) {
          halted = { index: flatIndex, reason: 'run stopped by you.' };
          break;
        }
        if (!handshakeDone) {
          // v0.2.2 version handshake: the frame is resolved by now
          // (post-navigation on mock visits, find-app-frame on live).
          // A stale in-page script would answer this probe but never
          // execute a step — refuse to start rather than hang.
          handshakeDone = true;
          const verdict = await checkExecutorVersion(ctx);
          if (verdict) {
            ctx.walk.neverStarted = true; // gated before step 1 — not a shippable run
            halted = { index: flatIndex, reason: verdict };
            break;
          }
        }
        const record = await dispatchStep(ctx, def);
        ctx.walk.records.push(record);
        if (record.scratch) ctx.walk.scratch = record.scratch;
        if (record.armed) ctx.walk.armed = record.armed;
        // A consent-limited step still gets its screenshot (§5: the
        // wall state is recorded as text AND image); gated skips and
        // handler-less limited steps never executed, so no shot.
        if (record.status !== 'skipped' && !(record.status === 'live-limited' && !record.wall)) {
          await captureStep(ctx, record);
        }
        renderStepRow(ctx, record);
        flatIndex += 1;

        if (ctx.abortedReason) {
          halted = { index: flatIndex, reason: ctx.abortedReason };
          break;
        }
        if (ctx.stopRequested) {
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
        if (ctx.endAfterStep) {
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
          if (ctx.walk.settings?.autoRun) {
            const auto = await walkSend(ctx, {
              type: 'tk-walk-auto-confirm', runId: ctx.walk.runId, appId: ctx.walk.appId ?? ctx.appId,
              capBuzz: ctx.walk.settings.autoCapBuzz ?? 0,
            }).catch((err) => ({ clicked: false, reason: `auto-confirm message failed: ${err?.message ?? err}` }));
            ctx.walk.events.push({
              kind: 'auto-confirm',
              stepId: def.id,
              detail: auto?.clicked
                ? `price-confirm auto-clicked at ${auto.price} Buzz (cap ${ctx.walk.settings.autoCapBuzz})`
                : `auto-confirm refused: ${auto?.reason ?? 'unknown reason'}`,
              outcome: auto?.clicked ? 'auto-confirmed by the runner under Auto mode' : 'fell back to the manual gate',
            });
            if (auto?.clicked) continue;
          }
          ctx.walk.events.push({
            kind: 'awaiting-user',
            stepId: def.id,
            detail: 'price-confirm card left open in the page; the runner will not click it',
            outcome: null,
          });
          showAwaitBanner(ctx,
            `Step “${def.id}” left a price-confirm card open in the page. ` +
              'The runner will not click it. Click Confirm in the app yourself if you want the spend to happen, then Continue — or End run here.',
          );
          const decision = await awaitDecision(ctx, 'gate', def.id);
          if (decision === 'end') {
            halted = { index: flatIndex, reason: 'run ended at the price-confirm card — your choice; nothing was clicked by the runner.' };
            break;
          }
          hideAwaitBanner(ctx);
        }
      }
      if (halted) break;
    }
  } catch (err) {
    halted = {
      index: flatIndex,
      reason: ctx.abortedReason ?? `run halted: ${err?.message ?? err}`,
    };
    // Nothing dispatched (e.g. no frame ever reported the app root):
    // the run never started, same as the version-handshake abort.
    if (flatIndex === 0 && !ctx.walk.records.some((r) => r.status !== 'skipped')) {
      ctx.walk.neverStarted = true;
    }
  }

  if (halted) {
    markRemainingSkipped(ctx, steps, halted.index, halted.reason);
    ctx.walk.halt = halted; // the report states where the run stopped, and why
  }
  // §5 containment: the scratch draft dies with the run, however it ended.
  await runScratchCleanup(ctx);
  ctx.walk.frameId = ctx.appFrameId ?? ctx.walk.frameId;
  ctx.walk.status = 'done';
  const counts = { pass: 0, fail: 0, skipped: 0, 'live-limited': 0, 'awaiting-user': 0 };
  for (const r of ctx.walk.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  setWalkStatus(ctx,
    `finished — ${counts.pass} passed · ${counts.fail} failed · ${counts.skipped} skipped · ${counts['live-limited']} live-limited`,
    counts.fail ? 'fail' : 'pass',
  );
  if (halted && counts.fail === 0) {
    appendWalkStatus(ctx, ` (${halted.reason})`);
  }
  if (ctx.consoleHookNote) {
    appendWalkStatus(ctx, ` (${ctx.consoleHookNote})`);
  }
  if (ctx.walk.cleanup?.failed?.length) {
    const names = ctx.walk.cleanup.failed.map((f) => `“${f.name}”`).join(', ');
    const b = APP_BINDINGS[ctx.walk.appId] ?? bindingFor(ctx);
    appendWalkStatus(ctx, ` ⚠ scratch cleanup incomplete — leftover ${b.scratchNoun}(s) ${names}; delete by hand (see report).`);
  }
  ctx.walkRunning = false;
  ctx.walkPaused = false;
  // The run is idle now: re-read what the tab reports today (its
  // navigations may have raced the frame registry while the run
  // was in flight) so the next Run is gated on fresh detection.
  if (!ctx.tabGone) {
    ctx.frames = await framesOf(ctx.tabId).catch(() => ctx.frames);
    applyDetectedBinding(ctx, { followView: ctx === viewCtx() });
    if (ctx === viewCtx()) $('tabInfo').textContent = tabStatusText(ctx);
  }
  paintControls(ctx);
  paintSteps(ctx);
  paintTargetOptions();
  // The finished (or stopped) run can now be turned into the bundle.
  if (!ctx.bundleFolder) ctx.bundleFolder = defaultBundleFolder(ctx);
  if (ctx === viewCtx()) $('bundleFolder').value = ctx.bundleFolder;
  // If the user had already returned to this tab while it ran, the
  // completion itself lands the view on the finished run.
  if (ctx === viewCtx()) void retryMissingScreenshots(ctx);
  // Auto-ship (v0.7.9): the run's snapshotted opt-in ships this tab's
  // own bundle once, through the same path the Ship button runs.
  // Retakes that land later keep the honest local-until-re-ship note.
  void maybeAutoShip(ctx);
}

$('btnWalkRun').addEventListener('click', () => {
  const ctx = viewCtx();
  if (ctx) void runWalk(ctx);
});
$('btnWalkPause').addEventListener('click', () => {
  const ctx = viewCtx();
  if (!ctx || !ctx.walkRunning) return;
  ctx.walkPaused = !ctx.walkPaused;
  paintControls(ctx);
  control(ctx, ctx.walkPaused ? 'pause' : 'resume');
  setWalkStatus(ctx, ctx.walkPaused ? 'paused — resume when ready' : 'running…', '');
});
$('btnWalkStop').addEventListener('click', () => {
  const ctx = viewCtx();
  if (!ctx || !ctx.walkRunning) return;
  ctx.stopRequested = true;
  ctx.walkPaused = false;
  control(ctx, 'stop');
  if (ctx.pendingDecision) resolveDecision(ctx, 'end');
  setWalkStatus(ctx, 'stopping…', '');
});
$('btnUserResume').addEventListener('click', () => {
  const ctx = viewCtx();
  if (ctx) resolveDecision(ctx, 'resume');
});
$('btnUserEnd').addEventListener('click', () => {
  const ctx = viewCtx();
  if (ctx) resolveDecision(ctx, 'end');
});
$('btnTargets').addEventListener('click', () => void refreshTargets());
$('targetSelect').addEventListener('change', async () => {
  const tabId = Number($('targetSelect').value);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) ensureCtx(tab);
  if (contexts.has(tabId)) await setView(tabId, { followView: true });
});
$('bundleFolder').addEventListener('input', () => {
  const ctx = viewCtx();
  if (ctx) ctx.bundleFolder = $('bundleFolder').value;
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
// anywhere (the §5 rail is untouched). Every function takes the run's
// context: Bundle/Ship always ship the VIEWED tab's run (v0.7.0).
// ---------------------------------------------------------------------

function catalogStep(ctx, id) {
  return catalogOf(ctx.walk?.appId ?? ctx.appId)?.catalog?.steps.find((s) => s.id === id) ?? null;
}
function catalogNumber(ctx, id) {
  const steps = catalogOf(ctx.walk?.appId ?? ctx.appId)?.catalog?.steps ?? [];
  const i = steps.findIndex((s) => s.id === id);
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
async function computeDiffs(ctx) {
  if (!state.baseline || !ctx.walk) return null;
  const out = [];
  for (const r of ctx.walk.records) {
    const cur = ctx.walk.shots[r.file];
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

function buildWalkReportMd(ctx, diffs) {
  const walk = ctx.walk;
  const records = walk.records;
  const entry = catalogOf(walk.appId ?? ctx.appId);
  const catalog = entry?.catalog ?? null;
  const stamp = entry?.stamp ?? {};
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
      (walk.settings?.autoShip
        ? 'auto-ship ON (bundle ships itself at walk end, else manual Ship) · '
        : '') +
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
      `| ${catalogNumber(ctx, r.id)} | ${r.name} | ${catalogStep(ctx, r.id)?.viewport ?? ''} | ${liveStatusLabel(r)} | ` +
        `${shot ? `[${r.file}](${r.file})` : r.shotMissing ? `${r.file} (unavailable)` : r.file} |`,
    );
  }
  lines.push('');
  for (const r of records) {
    const label = liveStatusLabel(r);
    lines.push(`## ${catalogNumber(ctx, r.id)}. ${r.name} — ${label}`);
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
      const retaken = r.shotRetakenAt
        ? `; retaken on return to the tab at ${r.shotRetakenAt}`
        : '';
      lines.push(
        '',
        `- _screenshot ${r.file} (~${Math.round((r.shotBytes ?? 0) / 1024)} KB${retaken})_`,
        '',
        `![${r.name}](${r.file})`,
        '',
      );
    } else if (r.shotMissing) {
      lines.push(
        '',
        `- _screenshot unavailable: ${r.shotMissing}. The assertions above were graded from the page itself; ${r.file} is named here and in the ship manifest rather than silently dropped._`,
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

function buildWalkStripHtml(ctx) {
  const walk = ctx.walk;
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
        `<strong>${catalogNumber(ctx, r.id)}. ${r.name}</strong> · ${catalogStep(ctx, r.id)?.viewport ?? ''} · ${liveStatusLabel(r)}</figcaption></figure>`,
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

function buildWalkTasteStripHtml(ctx, diffs) {
  const walk = ctx.walk;
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
      return `<tr><td><strong>${catalogNumber(ctx, r.id)}. ${r.name}</strong><br>${badge}</td><td>${oldImg}</td><td><img src="${r.file}" alt="current ${r.name}"></td></tr>`;
    })
    .join('\n');
  return (
    head +
    `<table><tr><td><strong>State</strong></td><td><strong>Baseline</strong></td><td><strong>Current</strong></td></tr>\n${rows}</table>\n`
  );
}

/** Assemble the whole bundle in memory (no downloads yet). */
async function collectWalkBundle(ctx) {
  if (!ctx?.walk) return null;
  const diffs = await computeDiffs(ctx);
  const reportMd = buildWalkReportMd(ctx, diffs);
  const stripHtml = buildWalkStripHtml(ctx);
  const tasteHtml = buildWalkTasteStripHtml(ctx, diffs);
  const files = [
    { path: 'report.md', kind: 'text', mime: 'text/markdown', text: reportMd },
    { path: 'strip.html', kind: 'text', mime: 'text/html', text: stripHtml },
    { path: 'taste-strip.html', kind: 'text', mime: 'text/html', text: tasteHtml },
  ];
  for (const r of ctx.walk.records) {
    const shot = ctx.walk.shots[r.file];
    if (shot) {
      files.push({
        path: r.file,
        kind: 'png',
        dataUrl: shot,
        ...(r.shotRetakenAt ? { retakenAt: r.shotRetakenAt } : {}),
      });
    }
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

// Walk IDs name their app (v0.7.9): walk-<app-slug>-YYYY-MM-DD-HHMM.
// The slug derives from the binding that ran the walk (its registry
// id, sanitized to lowercase-hyphen), never from a hardcoded pair —
// a future binding names its own runs the same way. Historical runs
// keep their pre-slug IDs; nothing is renamed retroactively.
function appSlugFor(appId) {
  const b = APP_BINDINGS[appId];
  const raw = b?.slug ?? b?.id ?? appId ?? 'app';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

// Folder-leaf uniqueness: the leaf is minute-grained, so two runs of
// the same app whose folders get stamped in the same minute (two
// tabs, v0.7.0 concurrency) would otherwise claim the same prefix
// and the second Ship would overwrite the first's bundle. Leafs are
// claimed per internal runId in this panel session; a collision
// earns a -SS suffix (and, pathologically, the tab id), so a claimed
// leaf is never reused by a different run. A run re-claiming its own
// leaf gets it back unchanged.
const folderLeafOwners = new Map(); // leaf -> walk.runId | `tab-${tabId}` | 'panel'

function defaultBundleFolder(ctx) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const me = ctx?.walk?.runId ?? (ctx ? `tab-${ctx.tabId}` : 'panel');
  let leaf =
    `walk-${appSlugFor(ctx?.walk?.appId ?? ctx?.appId)}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const owner = folderLeafOwners.get(leaf);
  if (owner && owner !== me) {
    leaf = `${leaf}-${p(d.getSeconds())}`;
    const owner2 = folderLeafOwners.get(leaf);
    if (owner2 && owner2 !== me) leaf = `${leaf}-${ctx?.tabId ?? 'x'}`;
  }
  folderLeafOwners.set(leaf, me);
  return `toil-killer/${leaf}`;
}

function bundleFolderValue(ctx) {
  // The folder input belongs to the VIEWED tab; a background tab's
  // bundle must never fall back to whatever it currently says.
  const fromInput = !ctx || ctx === viewCtx() ? $('bundleFolder').value : '';
  return (ctx?.bundleFolder || fromInput).trim().replace(/^\/+|\/+$/g, '') || defaultBundleFolder(ctx);
}

async function downloadWalkBundle() {
  const ctx = viewCtx();
  const bundle = await collectWalkBundle(ctx);
  if (!bundle) {
    if (ctx) setBundleStatus(ctx, 'run a walk first — there is nothing to bundle yet.');
    return [];
  }
  const prefix = bundleFolderValue(ctx);
  const ids = await downloadBundleFiles(bundle.files, prefix);
  setBundleStatus(ctx, `⬇ ${ids.length} files → Downloads/${prefix}/`);
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

// Ships one context's bundle. The Ship button ships the VIEWED tab's
// run (no argument); auto-ship passes the run that just finished, so
// concurrent tabs each ship only their own bundle.
async function shipToHomelab(forCtx) {
  const ctx = forCtx ?? viewCtx();
  const bundle = await collectWalkBundle(ctx);
  if (!bundle) {
    if (ctx) setShipStatus(ctx, 'Run a walk first.');
    return [];
  }
  const walk = ctx.walk;
  const prefix = bundleFolderValue(ctx);
  const counts = walkCounts(walk.records);
  const missingScreenshots = walk.records
    .filter((r) => r.shotMissing && !walk.shots[r.file])
    .map((r) => r.file);
  const fileBytes = [];
  const fileMeta = [];
  for (const f of bundle.files) {
    let buf;
    if (f.kind === 'text') buf = new TextEncoder().encode(f.text);
    else buf = Uint8Array.from(atob(f.dataUrl.slice(f.dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    fileBytes.push({ f, buf });
    fileMeta.push({
      path: f.path,
      bytes: buf.byteLength,
      sha256: await sha256Hex(buf),
      ...(f.retakenAt ? { retakenAt: f.retakenAt } : {}),
    });
  }
  const s3 = await loadS3Config();
  const manifest = {
    kind: 'toil-killer-ship',
    version: 1,
    createdAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    catalogHash: walk.catalogHash,
    targetUrl: walk.targetUrl,
    counts,
    halt: walk.halt ?? null,
    missingScreenshots,
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
      setShipStatus(ctx, `🚀 S3 ${i + 1}/${total} ${f.path}…`);
      done.push(await s3Put(s3, `${prefix}/${f.path}`, buf, f.mime || 'application/octet-stream'));
    }
    setShipStatus(ctx, `🚀 S3 ${total}/${total} ship-manifest.json…`);
    done.push(await s3Put(s3, `${prefix}/ship-manifest.json`, new TextEncoder().encode(manifestText), 'application/json'));
    setShipStatus(ctx, `🚀 S3 ✓ ${s3.bucket}/${prefix}/ — ${done.length} objects, hashes server-checked`);
    setShippedRun(ctx, prefix);
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
  setShipStatus(ctx,
    `🚀 ${ids.length} files → Downloads/${prefix}/` + (copied ? ' · prompt copied — paste to Muse' : ' (no S3 secret saved — see extension options)'));
  setShippedRun(ctx, prefix);
  return ids;
}

// Auto-ship (v0.7.9): fires exactly once when a run reaches the same
// completed end state that enables the manual Ship button — including
// fail-stopped and awaiting-user-ended runs, which still produce a
// bundle. A run that never started (version-handshake abort) ships
// nothing, and neither does a tab that has closed. The Ship itself is
// the manual path (S3 with a saved secret, else Downloads +
// clipboard); a failure surfaces in shipStatus and leaves the Ship
// button live — never swallowed, never retried in a loop.
async function maybeAutoShip(ctx) {
  const walk = ctx?.walk;
  if (!walk || walk.status !== 'done') return;
  if (walk.settings?.autoShip !== true) return;
  if (walk.neverStarted || ctx.tabGone || ctx.autoShipDone) return;
  ctx.autoShipDone = true;
  try {
    await shipToHomelab(ctx);
  } catch (err) {
    setShipStatus(ctx, `⚠ auto-ship failed: ${err?.message ?? err} — the bundle is unshipped; Ship to homelab when ready.`);
  }
}

async function saveWalkBaseline() {
  const ctx = viewCtx();
  const walk = ctx?.walk;
  if (!walk || walk.status !== 'done') {
    if (ctx) setBundleStatus(ctx, 'finish a walk first — a baseline is a finished run’s screenshots.');
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
    setBundleStatus(ctx, 'this run produced no screenshots — nothing to save as a baseline.');
    return [];
  }
  // Same manifest shape as tools/walk/baseline/manifest.json.
  files.push({
    path: 'manifest.json',
    kind: 'text',
    mime: 'application/json',
    text: JSON.stringify({ createdAt: new Date().toISOString(), base: walk.targetUrl, files: names }, null, 2),
  });
  const folder = `${bundleFolderValue(ctx)}-baseline`;
  const ids = await downloadBundleFiles(files, folder);
  setBundleStatus(ctx, `⬇ Baseline: ${ids.length} files → Downloads/${folder}/`);
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
  const ctx = viewCtx();
  const catalogFiles = new Set(catalogOf(ctx?.appId)?.catalog?.steps.map((s) => s.file) ?? []);
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
  const ctx = viewCtx();
  downloadWalkBundle().catch((err) => {
    if (ctx) setBundleStatus(ctx, `Bundle failed: ${err?.message ?? err}`);
  });
});
$('btnShip').addEventListener('click', () => {
  const ctx = viewCtx();
  shipToHomelab().catch((err) => {
    if (ctx) setShipStatus(ctx, `Ship failed: ${err?.message ?? err}`);
  });
});
$('btnCopyRunId').addEventListener('click', async () => {
  const ctx = viewCtx();
  const id = ctx?.shippedRunId;
  if (!id) return;
  const btn = $('btnCopyRunId');
  try {
    await navigator.clipboard.writeText(id);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1500);
  } catch {
    // Clipboard refused: leave the ID visibly selected instead.
    const range = document.createRange();
    range.selectNodeContents($('shipRunId'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});
$('btnSaveBaseline').addEventListener('click', () => {
  const ctx = viewCtx();
  saveWalkBaseline().catch((err) => {
    if (ctx) setBundleStatus(ctx, `baseline save failed: ${err?.message ?? err}`);
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
  buildFiles: () => collectWalkBundle(viewCtx()),
  downloadBundle: downloadWalkBundle,
  shipToHomelab,
  saveBaseline: saveWalkBaseline,
  importBaselineFiles,
  setBaseline: setBaselineMap,
  getBaseline: () => state.baseline,
  labelFor: liveStatusLabel,
  // v0.7.0: per-tab run summaries for the concurrency proof — the
  // same records the panel renders, keyed by tabId, without needing
  // the tab on screen.
  contextsByTab: () => Object.fromEntries(
    [...contexts.values()].map((c) => [c.tabId, {
      bindingAppId: c.appId,
      detectedAppId: c.detectedAppId,
      detectedRule: c.detectedRule,
      bindingSource: c.bindingSource,
      runAppId: c.walk?.appId ?? null,
      walkRunning: c.walkRunning,
      shippedRunId: c.shippedRunId ?? null,
      tabGone: c.tabGone,
    }]),
  ),
  walksByTab: () => Object.fromEntries(
    [...contexts.values()].map((c) => [c.tabId, !c.walk ? null : {
      appId: c.appId,
      bindingAppId: c.appId,
      detectedAppId: c.detectedAppId,
      detectedRule: c.detectedRule,
      bindingSource: c.bindingSource,
      runAppId: c.walk?.appId ?? null,
      tabGone: c.tabGone,
      status: c.walk.status,
      halt: c.walk.halt,
      scratch: c.walk.scratch,
      cleanup: c.walk.cleanup,
      missingScreenshots: c.walk.records.filter((r) => r.shotMissing && !c.walk.shots[r.file]).map((r) => r.file),
      records: c.walk.records.map((r) => ({
        id: r.id, file: r.file, status: r.status,
        shotMissing: r.shotMissing ?? null, shotBytes: r.shotBytes ?? null,
        shotRetakenAt: r.shotRetakenAt ?? null,
        checks: r.checks, notes: r.notes, errors: r.errors,
      })),
    }]),
  ),
};

// ---------------------------------------------------------------------
// Diagnostics: the four spike probes (unchanged behavior, now scoped
// to the viewed tab's context).
// ---------------------------------------------------------------------

async function runInject() {
  const ctx = viewCtx();
  if (!ctx || ctx.tabGone) return;
  if (ctx.frames.length === 0) {
    await findAppFrame(ctx);
    await refreshFrames(ctx);
  }
  if (ctx.frames.length === 0) {
    setVerdict('verdictInject', 'FAIL — no frames found; reload the app tab', 'fail');
    return;
  }
  setVerdict('verdictInject', 'scanning all frames…', '');
  try {
    // Always scan every known frame: the app may be the top frame
    // (standalone) or a child frame (embedded) — the probe figures
    // out which instead of asking the user.
    const perFrame = {};
    for (const frame of ctx.frames) {
      try {
        perFrame[`frame ${frame.frameId}`] = await sendProbe(ctx, frame.frameId, 'inject');
      } catch (e) {
        perFrame[`frame ${frame.frameId}`] = { note: `probe failed: ${e?.message ?? e}` };
      }
    }
    ctx.results.inject = perFrame;
    const binding = bindingFor(ctx);
    if (!binding) {
      setVerdict('verdictInject', 'PARTIAL — no app in this tab', 'partial');
      showJson('outInject', perFrame);
      return;
    }
    const flag = binding.frameFlag;
    const winner = ctx.frames.find((f) => perFrame[`frame ${f.frameId}`]?.[flag]);
    if (winner) {
      ctx.appFrameId = winner.frameId;
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
  const ctx = viewCtx();
  if (!ctx || ctx.tabGone) return;
  // The drive probe types into the Email Builder chat box; it has no
  // Open Datasets equivalent, so say so rather than failing oddly.
  if (ctx.appId !== 'email-builder') {
    setVerdict('verdictDrive', 'PARTIAL — Email Builder only (no chat box to drive here)', 'partial');
    showJson('outDrive', { note: 'drive probe is Email Builder only; use a walk run for this app.' });
    return;
  }
  setVerdict('verdictDrive', 'finding the app frame…', '');
  try {
    // Auto-detect: standalone apps are the top frame, embedded apps a
    // child frame. Never trust the dropdown — find the frame that
    // actually reports eb-app, then drive there.
    if (ctx.appFrameId == null) {
      const found = await findAppFrame(ctx);
      if (!found) {
        setVerdict('verdictDrive', 'FAIL — no frame sees the app (probe 4 tells the frame-by-frame story)', 'fail');
        showJson('outDrive', ctx.results.find ?? '(no find evidence)');
        return;
      }
    }
    const frameId = ctx.appFrameId;
    setVerdict('verdictDrive', `driving frame ${frameId}…`, '');
    const res = await sendProbe(ctx, frameId, 'drive');
    res.frameId = frameId;
    ctx.results.drive = res;
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
  const ctx = viewCtx();
  if (!ctx || ctx.tabGone) return;
  setVerdict('verdictCapture', 'running…', '');
  const res = await chrome.runtime.sendMessage({ type: 'tk-capture', tabId: ctx.tabId });
  if (res?.dataUrl) {
    ctx.shotDataUrl = res.dataUrl;
    const approxBytes = Math.round((res.dataUrl.length * 3) / 4);
    const pass = res.dataUrl.length > 10_000;
    ctx.results.capture = { ok: true, dataUrlChars: res.dataUrl.length, approxBytes };
    setVerdict('verdictCapture', pass ? `PASS (~${approxBytes.toLocaleString()} bytes)` : 'PARTIAL — capture returned but looks tiny/blank', pass ? 'pass' : 'partial');
    showJson('outCapture', ctx.results.capture);
    const img = $('shotPreview');
    img.src = res.dataUrl;
    img.hidden = false;
    $('btnShot').disabled = false;
  } else if (res?.screenshotUnavailable) {
    // The viewed tab is not the visible tab of its window (the panel
    // can be looking at a background tab) — say so, never substitute.
    ctx.results.capture = { ok: false, screenshotUnavailable: true, reason: res.reason ?? null };
    setVerdict('verdictCapture', 'PARTIAL — tab not visible in its window; no screenshot taken', 'partial');
    showJson('outCapture', ctx.results.capture);
  } else {
    // The failure evidence belongs in the report, not just on screen.
    ctx.results.capture = {
      ok: false,
      error: res?.error ?? 'unknown error (no response from background)',
      tabActive: res?.tabActive ?? null,
      windowFocused: res?.windowFocused ?? null,
    };
    setVerdict('verdictCapture', `FAIL — ${ctx.results.capture.error}`, 'fail');
    showJson('outCapture', ctx.results.capture);
  }
}

async function runDiagnose() {
  const ctx = viewCtx();
  if (!ctx || ctx.tabGone) return;
  setVerdict('verdictDiagnose', 'running…', '');
  try {
    // Top frame's inject probe carries the iframe inventory.
    let inventory = null;
    try {
      inventory = await sendProbe(ctx, 0, 'inject');
    } catch (e) {
      inventory = { note: `top-frame probe failed: ${e?.message ?? e}` };
    }
    const res = await chrome.runtime.sendMessage({ type: 'tk-diagnose', tabId: ctx.tabId });
    ctx.results.diagnose = { inventory, ...(res ?? {}) };

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
    showJson('outDiagnose', ctx.results.diagnose);
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

function buildReport(ctx) {
  const lines = [
    '# Toil-Killer P0 spike report',
    '',
    `- when: ${new Date().toISOString()}`,
    `- tab: ${ctx?.tab?.url ?? '(unknown)'}`,
    `- frames injected: ${ctx?.frames.length ?? 0}`,
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
  for (const [action, evidence] of Object.entries(ctx?.results ?? {})) {
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

$('btnFrames').addEventListener('click', async () => {
  const ctx = viewCtx();
  if (!ctx) return;
  const changed = await refreshFrames(ctx);
  if (changed) await setView(ctx.tabId, { skipFrameRefresh: true });
});
$('btnInject').addEventListener('click', runInject);
$('btnDrive').addEventListener('click', runDrive);
$('btnCapture').addEventListener('click', runCapture);
$('btnDiagnose').addEventListener('click', runDiagnose);
$('btnShot').addEventListener('click', () => {
  const ctx = viewCtx();
  if (ctx?.shotDataUrl) download('toil-killer-spike-shot.png', ctx.shotDataUrl);
});
$('btnReport').addEventListener('click', () => {
  const blob = new Blob([buildReport(viewCtx())], { type: 'text/markdown' });
  download('toil-killer-spike-report.md', URL.createObjectURL(blob), 'blob');
});
$('optScratch').addEventListener('change', () => {
  state.settings.allowScratchDrafts = $('optScratch').checked;
  persistSettings();
});
$('optLiveBranch').addEventListener('change', () => {
  state.liveBranch = $('optLiveBranch').checked;
});
for (const id of ['optAuto', 'optAutoCap', 'optAutoShip']) {
  $(id).addEventListener('change', () => {
    Object.assign(state.settings, autoSettings());
    persistSettings();
  });
}

// App picker: per-tab since v0.7.0 — it sets the VIEWED tab's
// binding (a run on another tab keeps its own and is untouched).
// Switching the viewed tab's app mid-run is refused (a bundle must
// never mix two apps); otherwise the outgoing group's selections are
// stashed, any finished walk is cleared so Bundle/Ship cannot ship
// the wrong app, and the new catalog + targets load.
$('appSelect').addEventListener('change', async () => {
  const ctx = viewCtx();
  const next = $('appSelect').value;
  if (!ctx) return;
  if (ctx.walkRunning) {
    $('appSelect').value = ctx.appId;
    setWalkStatus(ctx, 'finish the run before switching apps', 'fail');
    return;
  }
  if (!APP_BINDINGS[next] || next === ctx.appId) return;
  if (ctx.appId) state.settings.groupsByApp[ctx.appId] = groupSelection();
  ctx.appId = next;
  ctx.bindingSource = 'manual';
  ctx.manualOverride = true;
  state.settings.appId = next;
  state.settings.groups = state.settings.groupsByApp[next] ?? {};
  ctx.walk = null;
  ctx.results = {};
  ctx.liveDetail = {};
  ctx.liveStatus = {};
  if (ctx === viewCtx()) window.__tkWalk = null;
  paintSteps(ctx);
  paintControls(ctx);
  $('tabInfo').textContent = tabStatusText(ctx);
  paintTargetOptions();
  await persistSettings();
  await loadCatalogFor(next);
  await refreshTargets({ followView: false });
});

loadSettings().then(async () => {
  try {
    myWindowId = (await chrome.windows.getCurrent())?.id ?? null;
  } catch { /* focus-following falls back to any-window activation */ }
  await refreshTargets();
});
