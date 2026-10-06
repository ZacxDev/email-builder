// Toil-Killer spike content script.
//
// Runs in every frame the manifest matches. It only ever:
//   - reports what Email Builder DOM it can see (injection probe),
//   - clicks "New email" if no draft is open, types probe text into the
//     chat box, reads the Send button state, and CLEARS the box
//     (drive probe). It NEVER clicks Send and NEVER clicks a price
//     confirm — those code paths do not exist here, on purpose.
//   - announces itself to the background hub so the side panel can
//     list frames and route probes.
//
// It also stamps data attributes on <html> so a headless test can
// prove injection happened without any extension UI:
//   <html data-tk-spike="1" data-tk-spike-frame="top|frame">

(() => {
  const PROBE_TEXT = 'Spike probe — toil-killer test, please disregard.';
  const KNOWN_TESTIDS = [
    'eb-app', 'eb-new', 'eb-drafts', 'eb-current-draft', 'eb-transcript',
    'eb-chat-input', 'eb-send', 'eb-confirm', 'eb-notice', 'eb-preview',
    'eb-flash', 'eb-repair-offer', 'eb-draft-widget', 'eb-banner-img',
    'eb-banner-placeholder', 'eb-generate-bundle', 'eb-copy-html',
    'eb-headline', 'eb-rename-input',
  ];

  const isTop = window === window.top;
  document.documentElement.dataset.tkSpike = '1';
  document.documentElement.dataset.tkSpikeFrame = isTop ? 'top' : 'frame';

  const q = (testid) => document.querySelector(`[data-testid="${testid}"]`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 10_000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(stepMs);
    }
  }

  function presentTestids() {
    return KNOWN_TESTIDS.filter((id) => q(id) !== null);
  }

  function probeInject() {
    return {
      action: 'inject',
      url: location.href,
      isTop,
      title: document.title,
      readyState: document.readyState,
      ebAppFound: q('eb-app') !== null,
      presentTestids: presentTestids(),
    };
  }

  // React-safe value setting: use the native setter so React's change
  // tracking sees the new value, then fire a bubbling input event.
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: value,
    }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function probeDrive() {
    const evidence = {
      action: 'drive',
      url: location.href,
      isTop,
      mode: null,
      typedText: null,
      sendButton: null,
      confirmPresent: false,
      cleared: false,
      note: null,
    };
    if (!q('eb-app')) {
      evidence.note = 'eb-app not found on this frame — app not loaded here; drive probe stopped (fail-stop).';
      return evidence;
    }

    let input = q('eb-chat-input');
    if (input) {
      evidence.mode = 'current-draft (chat box already open; "New email" not clicked)';
    } else {
      const newBtn = q('eb-new');
      if (!newBtn) {
        evidence.note = 'No chat box and no eb-new button — drive probe stopped (fail-stop).';
        return evidence;
      }
      evidence.mode = 'clicked "New email" (eb-new) to open a fresh draft';
      newBtn.click();
      input = await waitFor(() => q('eb-chat-input'), 10_000);
      if (!input) {
        evidence.note = 'Clicked eb-new but eb-chat-input never appeared within 10s — drive probe stopped (fail-stop).';
        return evidence;
      }
    }

    setFieldValue(input, PROBE_TEXT);
    await sleep(600);
    evidence.typedText = 'value' in input ? input.value : input.textContent;

    const send = q('eb-send');
    evidence.sendButton = send
      ? { found: true, disabled: Boolean(send.disabled), label: (send.textContent || '').trim().slice(0, 60) }
      : { found: false };
    evidence.confirmPresent = q('eb-confirm') !== null;

    // Clear the box. Nothing was ever sent: eb-send is never clicked.
    if ('value' in input) setFieldValue(input, '');
    else input.textContent = '';
    await sleep(300);
    evidence.cleared = ('value' in input ? input.value : input.textContent) === '';
    evidence.note = 'Probe text typed and cleared. Send was never clicked; no confirm was clicked.';
    return evidence;
  }

  async function runProbe(action) {
    if (action === 'inject') return probeInject();
    if (action === 'drive') return probeDrive();
    return { action, note: `unknown probe action: ${action} (refused)` };
  }

  // Announce this frame to the hub (for the embedded-view stretch probe,
  // every frame reports in, so the panel can see which frames exist).
  try {
    chrome.runtime.sendMessage({
      type: 'tk-frame-hello',
      url: location.href,
      isTop,
      ebAppFound: q('eb-app') !== null,
    }).catch(() => {});
  } catch { /* extension context may not exist under test harnesses */ }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'tk-probe-run') {
      runProbe(msg.action)
        .then(sendResponse)
        .catch((err) => sendResponse({ action: msg.action, note: `probe threw: ${err?.message ?? err}` }));
      return true; // keep the message channel open for the async response
    }
    return false;
  });

  // Dev hook for headless verification, localhost harness only. Inert on
  // every live origin. Runs a probe and leaves the JSON in a node with
  // id="tk-spike-result" for a test driver to read.
  if (location.hostname === 'localhost') {
    document.addEventListener('tk-spike-dev', async (event) => {
      const result = await runProbe(event.detail?.action ?? 'inject');
      let node = document.getElementById('tk-spike-result');
      if (!node) {
        node = document.createElement('pre');
        node.id = 'tk-spike-result';
        node.style.display = 'none';
        document.body.appendChild(node);
      }
      node.textContent = JSON.stringify(result, null, 2);
    });
  }
})();
