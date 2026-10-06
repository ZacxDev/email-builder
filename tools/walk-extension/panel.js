// Toil-Killer spike side panel.
// Runs the three probes against the active tab and grades them:
//   PASS    — the evidence shows the thing actually worked
//   PARTIAL — part of it worked; the evidence says which part
//   FAIL    — it did not work; the evidence says why
// Nothing here can click Send or a price confirm: probes are sent to
// the content script, which has no such code path.

const PROBE_TEXT = 'Spike probe — toil-killer test, please disregard.';
const state = {
  tab: null,
  frames: [],
  results: {}, // action -> evidence (object or per-frame map)
  shotDataUrl: null,
};

const $ = (id) => document.getElementById(id);

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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function refreshFrames() {
  state.tab = await activeTab();
  if (!state.tab) {
    $('tabInfo').textContent = 'No active tab found.';
    return;
  }
  $('tabInfo').textContent = state.tab.url ?? '(no URL)';
  const res = await chrome.runtime.sendMessage({ type: 'tk-get-frames', tabId: state.tab.id });
  state.frames = res?.frames ?? [];
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
    opt.textContent = `${frame.isTop ? 'top' : `frame ${frame.frameId}`} · eb-app ${frame.ebAppFound ? 'seen' : 'not seen'} · ${frame.url}`;
    sel.appendChild(opt);
  }
  // Prefer a frame that actually saw the app.
  const appFrame = state.frames.find((f) => f.ebAppFound) ?? state.frames[0];
  sel.value = String(appFrame.frameId);
}

async function sendProbe(frameId, action) {
  return chrome.tabs.sendMessage(
    state.tab.id,
    { type: 'tk-probe-run', action },
    { frameId },
  );
}

async function runInject() {
  if (!state.tab || state.frames.length === 0) return;
  setVerdict('verdictInject', 'running…', '');
  try {
    if ($('allFrames').checked) {
      const perFrame = {};
      for (const frame of state.frames) {
        perFrame[`frame ${frame.frameId}`] = await sendProbe(frame.frameId, 'inject');
      }
      state.results.inject = perFrame;
      const anyApp = Object.values(perFrame).some((r) => r?.ebAppFound);
      setVerdict('verdictInject', anyApp ? 'PASS' : 'FAIL', anyApp ? 'pass' : 'fail');
      showJson('outInject', perFrame);
    } else {
      const frameId = Number($('frameSelect').value);
      const res = await sendProbe(frameId, 'inject');
      state.results.inject = res;
      const pass = Boolean(res?.ebAppFound);
      setVerdict('verdictInject', pass ? 'PASS' : 'FAIL', pass ? 'pass' : 'fail');
      showJson('outInject', res);
    }
  } catch (err) {
    setVerdict('verdictInject', 'FAIL', 'fail');
    showJson('outInject', `probe message failed: ${err?.message ?? err}`);
  }
}

async function runDrive() {
  if (!state.tab || state.frames.length === 0) return;
  const frameId = Number($('frameSelect').value);
  setVerdict('verdictDrive', 'running…', '');
  try {
    const res = await sendProbe(frameId, 'drive');
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
    setVerdict('verdictCapture', pass ? `PASS (~${approxBytes.toLocaleString()} bytes)` : 'PARTIAL — capture returned but looks tiny/blank', pass ? 'pass' : 'partial');
    const img = $('shotPreview');
    img.src = res.dataUrl;
    img.hidden = false;
    $('btnShot').disabled = false;
  } else {
    setVerdict('verdictCapture', 'FAIL', 'fail');
    showJson('outDrive', `capture failed: ${res?.error ?? 'unknown error'}`);
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
$('btnShot').addEventListener('click', () => {
  if (state.shotDataUrl) download('toil-killer-spike-shot.png', state.shotDataUrl);
});
$('btnReport').addEventListener('click', () => {
  const blob = new Blob([buildReport()], { type: 'text/markdown' });
  download('toil-killer-spike-report.md', URL.createObjectURL(blob), 'blob');
});

refreshFrames();
