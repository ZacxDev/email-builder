// Toil-Killer spike background hub.
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

const framesByTab = new Map(); // tabId -> Map(frameId -> {url, isTop, ebAppFound, dcAppFound, appId})

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
    const frames = framesByTab.get(msg.tabId);
    sendResponse({ frames: frames ? [...frames.values()] : [] });
    return false;
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
      // captureVisibleTab can fail transiently; try twice, and report
      // the tab/window state alongside any error so a failure is
      // self-diagnosing in the downloaded report.
      let lastError = null;
      let tab = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          tab = await chrome.tabs.get(msg.tabId);
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          sendResponse({ dataUrl });
          return;
        } catch (err) {
          lastError = String(err?.message ?? err);
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      let windowFocused = null;
      try {
        const win = await chrome.windows.get(tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT);
        windowFocused = Boolean(win?.focused);
      } catch { /* diagnostic only */ }
      sendResponse({
        error: lastError ?? 'capture failed',
        tabActive: tab ? Boolean(tab.active) : null,
        windowFocused,
      });
    })();
    return true; // async response
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => framesByTab.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') framesByTab.delete(tabId);
});
