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

const framesByTab = new Map(); // tabId -> Map(frameId -> {url, isTop, ebAppFound})

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
    });
    return false;
  }

  if (msg?.type === 'tk-get-frames') {
    const frames = framesByTab.get(msg.tabId);
    sendResponse({ frames: frames ? [...frames.values()] : [] });
    return false;
  }

  if (msg?.type === 'tk-capture') {
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        sendResponse({ dataUrl });
      } catch (err) {
        sendResponse({ error: String(err?.message ?? err) });
      }
    })();
    return true; // async response
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => framesByTab.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') framesByTab.delete(tabId);
});
