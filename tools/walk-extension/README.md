# Toil-Killer spike extension

The P0 spike for the toil-killer browser extension (spec:
`../../files/toil-killer-extension-spec.md`, §7). It proves — or
disproves — three things against the **live** Email Builder app in a
real, signed-in browser:

1. **Injection** — the probe can see the app's DOM hooks
   (`data-testid="eb-*"`) on the served page.
2. **Driving** — it can click “New email”, type into the chat box, and
   read the Send button's state. It types probe text and **clears it
   without ever clicking Send**. There is no code path that clicks
   Send or a price confirm.
3. **Capture** — `chrome.tabs.captureVisibleTab` returns a real
   screenshot, the same primitive the full walk will use.

Plus a stretch check: run probe 1 with “all frames” on the app as
embedded inside civitai.com to see which frames the probe reaches.

## Install (unpacked, ~1 minute)

1. Open `chrome://extensions` in the Chrome profile where you're
   signed in to Civitai.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → pick this folder (`tools/walk-extension` inside
   the email-builder app).
4. Pin the “Toil-Killer Spike” icon if you like; clicking it opens
   the side panel.

## Run

1. Open **https://email-builder.civit.ai** (signed in). If the tab was
   already open, reload it — the probe injects on page load.
2. Click the extension icon. In **Target**, confirm your tab's URL is
   listed and a frame shows “eb-app seen”. If the frame list is empty,
   hit **Refresh frames** after the reload.
3. **1 · Injection probe** → expect **PASS**.
4. **2 · Drive probe** → expect **PASS**. Heads-up: if no draft is
   open it clicks “New email”, which can leave a fresh empty draft in
   your Library — delete it afterwards. The probe text it types is
   never sent.
5. **3 · Capture probe** → expect **PASS** and a screenshot preview.
6. **Download spike report (.md)** and send that file back. It
   contains the verdicts plus the raw evidence.

Stretch (optional): open Email Builder from inside civitai.com, tick
**Run injection probe on all frames**, and run probe 1 again. The
report then shows exactly which frames the probe could see — that
settles whether the embedded view is a viable target or the
standalone origin is the one.

## Remove

`chrome://extensions` → **Remove** on “Toil-Killer Spike (Email
Builder)”. It stores nothing anywhere; the frame registry lives in
memory only.

## Files

- `manifest.json` — MV3; hosts limited to `*.civit.ai`, `civitai.com`,
  and the local mock harness (`localhost:5186`, so the same probes can
  be rehearsed against the walk harness).
- `content.js` — the probes. Also stamps `data-tk-spike` on `<html>`
  so headless tests can prove injection without any UI. On
  `localhost` only, it additionally answers a `tk-spike-dev` DOM event
  so the sandbox test driver can run probes headlessly; that hook is
  inert on every live origin.
- `background.js` — frame registry + screenshot service.
- `panel.html` / `panel.js` — the side-panel UI and verdict grading.
