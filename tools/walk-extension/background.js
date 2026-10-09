// Toil-Killer background hub.
//
// Deliberately thin. It only:
//   - opens the side panel when the toolbar icon is clicked,
//   - keeps a registry of frames whose content script actually
//     injected (the embedded-view question is "did we get into the
//     frame at all", so this registry is the spike's core evidence),
//   - takes screenshots on the panel's behalf
//     (chrome.tabs.captureVisibleTab lives here).
//
// It holds no credentials and talks to nothing off-device.
//
// Multi-tab (v0.7.0): every request names its tabId and is served
// for that tab only. Screenshots are pinned to the requested tab —
// captureVisibleTab photographs the ACTIVE tab of a window, so a
// capture for a tab that is not its window's visible tab is refused
// as screenshotUnavailable instead of returning another tab's
// pixels. Captures serialize through a small spacing queue (Chrome
// rate-limits the API); the queue never gates execution, only the
// shots themselves.
//
// Registry self-heal (v0.7.2): framesByTab lives in this worker's
// memory and is fed by content-script announcements, which fire at
// page load (plus a short retry window). An MV3 service-worker
// restart wipes it, and already-loaded tabs never re-announce —
// v0.7.1's auto-select then read every tab as "no app". So
// tk-get-frames no longer trusts the registry alone: when it holds
// no app root for a tab, the hub probes the tab's frames on demand
// (resident probe first, a scripting DOM check when no script
// answers) and refills the registry. Probing happens on request
// only — never on a timer — and a recent empty probe is cached
// briefly so repaint loops don't probe-storm.

const framesByTab = new Map(); // tabId -> Map(frameId -> {url, isTop, ebAppFound, dcAppFound, appId})
const probeAtByTab = new Map(); // tabId -> ms timestamp of the last on-demand probe
const probePendingByTab = new Map(); // tabId -> Promise<frames[]> (dedupes concurrent probes)
const PROBE_STALE_MS = 2_000;
const PROBE_MSG_TIMEOUT_MS = 3_000;

function frameEntry(frameId, url, isTop, ev) {
  const ebAppFound = Boolean(ev?.ebAppFound);
  const dcAppFound = Boolean(ev?.dcAppFound);
  return {
    frameId,
    url,
    isTop: Boolean(isTop),
    ebAppFound,
    dcAppFound,
    appFound: ebAppFound || dcAppFound,
    appId: ev?.appId ?? (dcAppFound ? 'open-datasets' : ebAppFound ? 'email-builder' : null),
    appRootTestid:
      ev?.appRootTestid ?? (dcAppFound ? 'dc-community' : ebAppFound ? 'eb-app' : null),
  };
}

function rememberFrame(tabId, entry) {
  if (!framesByTab.has(tabId)) framesByTab.set(tabId, new Map());
  framesByTab.get(tabId).set(entry.frameId, entry);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Ask one frame what it sees: the resident content script first;
 *  if none answers (orphaned by an extension reload, or never
 *  injected), a one-shot scripting DOM check. Detection only needs
 *  the app roots — running a walk still goes through the panel's
 *  executor version handshake, which is what demands a live
 *  current-build content script. */
async function probeOneFrame(tabId, navFrame) {
  let ev = null;
  try {
    ev = await withTimeout(
      chrome.tabs.sendMessage(
        tabId, { type: 'tk-probe-run', action: 'inject' }, { frameId: navFrame.frameId },
      ),
      PROBE_MSG_TIMEOUT_MS,
    );
  } catch {
    ev = null;
  }
  if (!ev || (ev.ebAppFound === undefined && ev.dcAppFound === undefined)) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [navFrame.frameId] },
        func: () => ({
          ebAppFound: document.querySelector('[data-testid="eb-app"]') !== null,
          dcAppFound: document.querySelector('[data-testid="dc-community"]') !== null,
        }),
      });
      if (res?.result) ev = res.result;
    } catch {
      /* frame unreachable — recorded below as no app seen */
    }
  }
  return frameEntry(
    navFrame.frameId,
    navFrame.url,
    navFrame.parentFrameId === -1 || navFrame.frameId === 0,
    ev,
  );
}

/** Enumerate a tab's frames, probe each, and refill the registry.
 *  Concurrent calls for one tab share a single probe. */
async function probeTabFrames(tabId) {
  if (probePendingByTab.has(tabId)) return probePendingByTab.get(tabId);
  const run = (async () => {
    let navFrames = null;
    try {
      navFrames = await chrome.webNavigation.getAllFrames({ tabId });
    } catch {
      navFrames = null; // tab gone — fall through to whatever is known
    }
    if (!navFrames) {
      return framesByTab.has(tabId) ? [...framesByTab.get(tabId).values()] : [];
    }
    const entries = [];
    for (const f of navFrames) entries.push(await probeOneFrame(tabId, f));
    framesByTab.set(tabId, new Map(entries.map((e) => [e.frameId, e])));
    probeAtByTab.set(tabId, Date.now());
    return entries;
  })();
  probePendingByTab.set(tabId, run);
  try {
    return await run;
  } finally {
    probePendingByTab.delete(tabId);
  }
}

let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
function enqueueCapture(job) {
  const run = captureQueue.then(async () => {
    const waitMs = Math.max(0, lastCaptureAt + 400 - Date.now());
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      return await job();
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'tk-frame-hello' && sender.tab) {
    const tabId = sender.tab.id;
    if (!framesByTab.has(tabId)) framesByTab.set(tabId, new Map());
    framesByTab.get(tabId).set(sender.frameId ?? 0, {
      frameId: sender.frameId ?? 0,
      url: msg.url,
      isTop: Boolean(msg.isTop),
      ebAppFound: Boolean(msg.ebAppFound),
      dcAppFound: Boolean(msg.dcAppFound),
      appFound: Boolean(msg.ebAppFound || msg.dcAppFound),
      appId: msg.appId ?? null,
      appRootTestid: msg.appRootTestid ?? null,
    });
    return false;
  }

  if (msg?.type === 'tk-get-frames') {
    (async () => {
      const known = framesByTab.has(msg.tabId) ? [...framesByTab.get(msg.tabId).values()] : [];
      // Registry already sees an app root — announcements are
      // fresher than any probe; answer from them.
      if (known.some((f) => f.appFound)) {
        sendResponse({ frames: known });
        return;
      }
      // No root known: either the tab truly has no app, or this
      // worker restarted and the tab's announcements died with the
      // old instance. Probe on demand (deduplicated, and skipped
      // when an equally empty probe just ran) and refill.
      const lastProbe = probeAtByTab.get(msg.tabId) ?? 0;
      if (Date.now() - lastProbe < PROBE_STALE_MS) {
        sendResponse({ frames: known });
        return;
      }
      try {
        sendResponse({ frames: await probeTabFrames(msg.tabId) });
      } catch {
        sendResponse({ frames: known });
      }
    })();
    return true; // async response
  }

  if (msg?.type === 'tk-find-app-frame') {
    // "The app frame" = whichever frame reports the picked app's root
    // testid, top or child. Embedded apps always live in a child
    // iframe; standalone apps are the top frame. This finds it without
    // the registry and without the user picking a frame by hand:
    // enumerate frames, ask each resident probe, return the first
    // that sees the app. `appId` selects the binding ('email-builder'
    // -> eb-app, 'open-datasets' -> dc-community); omitted appId keeps
    // the any-app behavior. If the tab id is omitted, the sender's
    // tab is used.
    (async () => {
      try {
        const tabId = msg.tabId ?? sender.tab?.id;
        const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
        const attempts = [];
        for (const f of frames) {
          const entry = { frameId: f.frameId, url: f.url };
          try {
            entry.evidence = await chrome.tabs.sendMessage(
              tabId, { type: 'tk-probe-run', action: 'inject' }, { frameId: f.frameId },
            );
          } catch (e) {
            entry.error = String(e?.message ?? e);
          }
          if (entry.evidence) {
            // A probe sighting is registry evidence too — later
            // tk-get-frames answers shouldn't un-see this app.
            rememberFrame(tabId, frameEntry(
              f.frameId, f.url, f.parentFrameId === -1 || f.frameId === 0, entry.evidence,
            ));
          }
          attempts.push(entry);
          const ev = entry.evidence;
          const matches =
            msg.appId === 'open-datasets' ? Boolean(ev?.dcAppFound)
            : msg.appId === 'email-builder' ? Boolean(ev?.ebAppFound)
            : Boolean(ev?.ebAppFound || ev?.dcAppFound);
          if (ev && matches) {
            sendResponse({
              frameId: f.frameId,
              url: f.url,
              appId: ev.appId ?? null,
              appRootTestid: ev.appRootTestid ?? null,
              attempts,
            });
            return;
          }
        }
        sendResponse({ frameId: null, attempts });
      } catch (err) {
        sendResponse({ frameId: null, error: String(err?.message ?? err), attempts: [] });
      }
    })();
    return true; // async response
  }

  if (msg?.type === 'tk-diagnose') {
    // Embedded-view diagnosis: enumerate every frame in the tab, then
    // try BOTH doors into each one — the already-announced content
    // script (message) and a fresh chrome.scripting injection — and
    // report exactly which door opened, or the exact error that
    // closed it. The iframe inventory itself comes from the top
    // frame's inject probe (the panel calls that too).
    (async () => {
      try {
        const frames = (await chrome.webNavigation.getAllFrames({ tabId: msg.tabId })) ?? [];
        const attempts = [];
        for (const f of frames) {
          const entry = { frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId };
          try {
            entry.viaMessage = await chrome.tabs.sendMessage(
              msg.tabId, { type: 'tk-probe-run', action: 'inject' }, { frameId: f.frameId },
            );
          } catch (e) {
            entry.viaMessageError = String(e?.message ?? e);
          }
          try {
            const [res] = await chrome.scripting.executeScript({
              target: { tabId: msg.tabId, frameIds: [f.frameId] },
              func: () => ({
                href: location.href,
                ebAppFound: document.querySelector('[data-testid="eb-app"]') !== null,
                dcAppFound: document.querySelector('[data-testid="dc-community"]') !== null,
                appFound:
                  document.querySelector('[data-testid="eb-app"]') !== null ||
                  document.querySelector('[data-testid="dc-community"]') !== null,
                ebTestidCount: document.querySelectorAll('[data-testid^="eb-"]').length,
                dcTestidCount: document.querySelectorAll('[data-testid^="dc-"]').length,
              }),
            });
            entry.viaScripting = res?.result ?? null;
          } catch (e) {
            entry.viaScriptingError = String(e?.message ?? e);
          }
          attempts.push(entry);
        }
        sendResponse({
          frames: frames.map((f) => ({ frameId: f.frameId, url: f.url, parentFrameId: f.parentFrameId })),
          attempts,
        });
      } catch (err) {
        sendResponse({ error: String(err?.message ?? err) });
      }
    })();
    return true; // async response
  }

  if (msg?.type === 'tk-capture') {
    (async () => {
      // Pinned to the requested tab (v0.7.0): the tab must be its
      // window's visible tab at capture time — captureVisibleTab
      // photographs whatever tab IS visible, so anything else would
      // file another tab's pixels under this run's step name. A
      // hidden tab gets an honest screenshotUnavailable, never a
      // focus steal. Runs in different windows are unaffected: each
      // window's visible tab captures normally.
      let tab = null;
      try {
        tab = await chrome.tabs.get(msg.tabId);
      } catch {
        sendResponse({ error: `tab ${msg.tabId} no longer exists — screenshot not captured` });
        return;
      }
      const out = await enqueueCapture(async () => {
        // captureVisibleTab can fail transiently; try twice, and
        // report the tab/window state alongside any error so a
        // failure is self-diagnosing in the downloaded report.
        let lastError = null;
        let current = tab;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            current = await chrome.tabs.get(msg.tabId);
            if (!current.active) {
              return {
                screenshotUnavailable: true,
                tabActive: false,
                reason:
                  'the tab was not the visible tab in its window when the screenshot was due; ' +
                  'no screenshot was captured (another tab’s pixels are never substituted, and focus is never stolen for a shot)',
              };
            }
            const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'png' });
            return { dataUrl };
          } catch (err) {
            lastError = String(err?.message ?? err);
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        let windowFocused = null;
        try {
          const win = await chrome.windows.get(current?.windowId ?? chrome.windows.WINDOW_ID_CURRENT);
          windowFocused = Boolean(win?.focused);
        } catch { /* diagnostic only */ }
        return {
          error: lastError ?? 'capture failed',
          tabActive: current ? Boolean(current.active) : null,
          windowFocused,
        };
      });
      sendResponse(out);
    })();
    return true; // async response
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  framesByTab.delete(tabId);
  probeAtByTab.delete(tabId);
  probePendingByTab.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    framesByTab.delete(tabId);
    // The new page must be probed fresh — an empty verdict cached
    // for the old page says nothing about the new one.
    probeAtByTab.delete(tabId);
  }
});
