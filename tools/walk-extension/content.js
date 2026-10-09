// Toil-Killer content script: spike probes + the walk step executor.
//
// Two jobs, one page:
//
// 1. SPIKE PROBES (the diagnostics — unchanged in behavior):
//    - reports what Email Builder DOM it can see (injection probe),
//    - clicks "New email" if no draft is open, types probe text into the
//      chat box, reads the Send button state, and CLEARS the box (drive
//      probe). It NEVER clicks Send and NEVER clicks a price confirm —
//      those code paths do not exist here, on purpose.
//    - announces itself to the background hub so the side panel can
//      list frames and route probes.
//
// 2. WALK EXECUTOR (§8.3, live adaptation §8.6): executes ONE catalog
//    step (tools/walk/steps.json, relayed by the panel) against this
//    frame's DOM and returns a per-step record
//    {id, status, checks, notes, errors}. Checks poll until timeout;
//    they never sample once. Honesty gates (liveClass) fire before any
//    handler runs.
//
// SAFETY RAILS (spec §5) ARE STRUCTURAL, NOT CONVENTIONAL:
//   - Every click any handler makes goes through clickTestId(), which
//     throws on spend-confirm testids ('eb-confirm-run'). There is no
//     code path in this file that clicks a price confirm.
//   - Spend outcomes (bundle-outcome, banner-generated, …) run only
//     behind the panel's awaiting-user gate: the user clicked Confirm
//     in the page themselves; the handler then reads the outcome.
//   - Consent walls are detected and recorded verbatim, never clicked
//     through (the step ends live-limited: consent, §8.6).
//   - Stateful steps touch only this run's own walk-scratch-* draft,
//     behind an id+name guard; that draft is deleted at run end (§8.6).
//   - Fail-stop: a failed check, a page error, or an unexpected modal
//     ends the step as fail; the panel stops the run.

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

  // Executor build, read from this extension's own manifest at
  // runtime (never a hardcoded duplicate). Stamped on every probe /
  // announce response and every step record so the panel can
  // handshake versions before a run (v0.2.2): a frame still holding a
  // content script from before an extension reload answers probes
  // but never executes new step messages. If the runtime context is
  // already gone (orphaned script), this reads null — which the
  // panel treats as "no version reported", i.e. stale.
  const EXECUTOR_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version ?? null;
    } catch {
      return null;
    }
  })();

  const q = (testid) => document.querySelector(`[data-testid="${testid}"]`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (testid) => q(testid)?.textContent ?? '';

  async function waitFor(fn, timeoutMs = 10_000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(stepMs);
    }
  }

  const DC_KNOWN_TESTIDS = [
    'dc-community', 'dc-explore-search', 'dc-explore-sort', 'dc-create-dataset',
    'dc-dataset-detail', 'dc-dataset-form', 'dc-train', 'dc-lora', 'dc-ledger-view',
  ];

  function presentTestids() {
    const out = new Set(
      [...KNOWN_TESTIDS, ...DC_KNOWN_TESTIDS].filter((id) => q(id) !== null),
    );
    // Both bindings' testids are discovered dynamically too, capped so
    // the evidence stays small on a busy page.
    for (const el of document.querySelectorAll('[data-testid]')) {
      const id = el.getAttribute('data-testid');
      if (id && (id.startsWith('eb-') || id.startsWith('dc-'))) out.add(id);
      if (out.size >= 120) break;
    }
    return [...out].slice(0, 120);
  }

  function probeInject() {
    const ebFound = q('eb-app') !== null;
    const dcFound = q('dc-community') !== null;
    const evidence = {
      action: 'inject',
      executorVersion: EXECUTOR_VERSION,
      url: location.href,
      isTop,
      title: document.title,
      readyState: document.readyState,
      ebAppFound: ebFound,
      dcAppFound: dcFound,
      appFound: ebFound || dcFound,
      appId: dcFound ? 'open-datasets' : ebFound ? 'email-builder' : null,
      appRootTestid: dcFound ? 'dc-community' : ebFound ? 'eb-app' : null,
      presentTestids: presentTestids(),
    };
    // On the top frame, inventory the child frames: HOW the app frame
    // is built (src vs srcdoc, sandbox tokens) is the evidence that
    // explains an embedded-view failure without guessing.
    if (isTop) {
      evidence.iframes = [...document.querySelectorAll('iframe')].map((f) => ({
        src: (f.getAttribute('src') ?? '').slice(0, 140) || null,
        hasSrcdoc: f.hasAttribute('srcdoc'),
        sandbox: f.getAttribute('sandbox'),
        name: f.getAttribute('name'),
      }));
    }
    return evidence;
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
      executorVersion: EXECUTOR_VERSION,
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

  // =======================================================================
  // Walk executor (§8.3)
  // =======================================================================

  // THE RAIL (spec §5): spend-confirm testids the click primitive
  // refuses, by construction. 'eb-confirm-run' is the app's priced
  // "Confirm" action; no handler, probe, or future code in this file
  // can click it, because every click goes through clickTestId().
  const SPEND_CONFIRM_TESTIDS = ['eb-confirm-run', 'dc-confirm-submit', 'dc-lora-confirm-submit'];

  const CHECK_TIMEOUT_MS = 10_000;
  const STEP_WATCHDOG_MS = 150_000;
  // Handlers that wait out live generation via the state-aware
  // working ceiling (300s) need a watchdog budget above it — the
  // watchdog still fails a genuinely wedged step, it just does not
  // strangle a wait the design deliberately allows.
  const WORKING_WATCHDOG_MS = 360_000;
  const WORKING_WATCHDOG_HANDLERS = new Set([
    'bundleOutcome', 'interviewChatTurn', 'bannerGenerated',
  ]);

  // State-aware generation wait (v0.7.4). The app exposes its busy
  // state as the eb-typing row (rendered whenever its phase is
  // estimating/working), and its own submit→poll loop has no hard
  // ceiling — it polls at an 8s cadence until terminal or unreachable
  // (app src/email/money.ts runToTerminal). A fixed 60s grading clock
  // therefore fails live generations that are merely slow (live run
  // walk-2026-10-08-1327: 107 Buzz confirmed, app still WORKING at
  // the old ~68s mark). While eb-typing persists past the soft window,
  // keep waiting up to this ceiling; a generation still working at the
  // ceiling is graded live-limited (outcome unknown), never passed and
  // never called a failure the evidence does not support.
  const WORKING_CEILING_MS = 300_000;

  /** Poll `probe` (terminal hit or null). While the app reports
   *  working (eb-typing), the wait extends from softMs to the working
   *  ceiling. Returns { hit, sawWorking, waitedMs, ceilingHit }. */
  async function waitTerminalWorkingAware(probe, { softMs = 60_000, onWorking = null } = {}) {
    const startedAt = Date.now();
    let sawWorking = false;
    let lastBeat = 0;
    for (;;) {
      const hit = await waitPoll(probe, 2_000).catch((e) => { throw e; });
      if (hit) return { hit, sawWorking, waitedMs: Date.now() - startedAt, ceilingHit: false };
      if (q('eb-typing')) {
        sawWorking = true;
        // Proof of life for the panel's dispatch-liveness clock: a
        // multi-minute working wait must not read as executor
        // silence (180s) — heartbeat every ~15s while working.
        if (onWorking && Date.now() - lastBeat >= 15_000) {
          lastBeat = Date.now();
          onWorking();
        }
      }
      const waitedMs = Date.now() - startedAt;
      const limit = sawWorking ? WORKING_CEILING_MS : softMs;
      if (waitedMs >= limit) return { hit: null, sawWorking, waitedMs, ceilingHit: sawWorking };
    }
  }

  const SKIP_LIVE_REASONS = {
    'wall-guest': 'needs a logged-out profile; the signed-in session cannot show the guest wall (spec §6). The mock walk owns this state.',
    'wall-consent': 'cannot be forced on a consenting account; detected-if-present only (spec §6). The mock walk owns this state.',
    'wall-insufficient': 'cannot be forced without draining the account — never (spec §6). The mock walk owns this state.',
  };
  // §6's open question, settled in §8.6: the app offers no UI to set or
  // edit a banner URL, so a dead-banner state cannot be manufactured
  // live. The broken-banner steps are detection-driven instead — they
  // run for real when the open draft already shows the placeholder.
  const DEAD_BANNER_SETTLEMENT =
    'the open draft does not show the “Banner image unavailable” placeholder, and the app offers no UI to set or edit a banner URL, so a dead-banner state cannot be manufactured live (settled §8.6). The mock walk owns this state; with a dead-banner draft already open, this step runs for real.';
  const LIVE_LIMITED_REASON = DEAD_BANNER_SETTLEMENT;

  // Live-mode calibration (§8.8). On a real origin the account's own
  // drafts are the fixture, so the read-only handlers assert STATE
  // (what the open draft shows) instead of the mock seed's draft
  // names and canned strings. On the localhost harness the mock
  // bodies run byte-identical — unless the panel forces live-mode
  // (`tk-walk-step.liveBranch`), the proof override that rehearses
  // the account-shaped assertions headlessly on the harness.
  const ON_HARNESS =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isLiveMode = (msg) => !ON_HARNESS || msg?.liveBranch === true;

  // Run control shared by the executor, the control-message listener,
  // and every polling loop. Pause freezes deadlines; stop aborts.
  const walkCtl = {
    runId: null,
    active: false,
    paused: false,
    stopped: false,
    awaiting: null, // { resolve } while a handler waits on the user
  };

  class StopError extends Error {
    constructor() { super('stopped by user'); this.tkStop = true; }
  }

  /** A consent/host wall was detected mid-step (spec §5): the step
   *  ends live-limited: consent with the state recorded verbatim. */
  class ConsentWallError extends Error {
    constructor(wallText) {
      super(`consent wall detected: ${wallText}`);
      this.tkWall = 'consent';
      this.wallText = wallText;
    }
  }

  // Consent-wall detection (§5/§8.6): the app surfaces a refused or
  // unavailable consent as an eb-notice. ONLY hard-wall wording counts
  // — the transient "This needs your permission to spend Buzz…" park
  // notice (consent pending, grant still possible) must NOT trip
  // this, and neither may unrelated notices (guest, pricing hiccups).
  function consentWallText() {
    const text = (textOf('eb-notice') ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    if (/be granted in this context/i.test(text)) return text.slice(0, 500);
    if (/missing permissions/i.test(text)) return text.slice(0, 500);
    return null;
  }

  function sendProgress(evt) {
    try {
      chrome.runtime.sendMessage({
        type: 'tk-walk-progress',
        runId: walkCtl.runId,
        frameUrl: location.href,
        ...evt,
      }).catch(() => {});
    } catch { /* panel may be gone; the step record still returns */ }
  }

  // Poll until fn() is truthy or timeout. Pause-aware: while paused the
  // deadline stops advancing. Stop throws StopError. Returns the truthy
  // value, or null on timeout.
  async function waitPoll(fn, timeoutMs, stepMs = 200) {
    let deadline = Date.now() + timeoutMs;
    for (;;) {
      if (walkCtl.stopped) throw new StopError();
      if (walkCtl.paused) {
        deadline += stepMs;
        await sleep(stepMs);
        continue;
      }
      const value = fn();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(stepMs);
    }
  }

  // The step execution watchdog: a wedged handler fails the step
  // instead of hanging the run. Only EXECUTION time burns the fuse:
  // pause time never counted, and neither does time parked in a §5
  // user halt (walkCtl.awaiting pending) — an awaiting-user park is
  // decided by the user's Resume/End alone, however long they take
  // (v0.2.3: a deliberate park must not read as a runaway step, the
  // way the panel-gated price cards already wait indefinitely).
  // Resolves quietly when the handler settles or the run stops;
  // rejects with the watchdog error once execution time exceeds
  // budgetMs. `isSettled` is a callback (and budgetMs a parameter)
  // so the localhost dev hook below can drive this exact accounting
  // with a short fuse against a fake handler.
  function watchStepExecution(isSettled, budgetMs = STEP_WATCHDOG_MS) {
    return (async () => {
      let waited = 0;
      for (;;) {
        await sleep(500);
        if (isSettled() || walkCtl.stopped) return;
        if (!walkCtl.paused && !walkCtl.awaiting) waited += 500;
        if (waited > budgetMs) {
          throw new Error(
            `step exceeded ${budgetMs / 1000}s watchdog (execution time; pauses and user halts don’t count) — failed rather than hang the run`,
          );
        }
      }
    })();
  }

  const isVisible = (el) =>
    Boolean(el) && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // THE click primitive. Every handler click goes through here, and
  // here is where the spend-confirm rail lives.
  async function clickTestId(testid, timeoutMs = 15_000) {
    if (SPEND_CONFIRM_TESTIDS.includes(testid)) {
      throw new Error(
        `RAIL: refusing to click spend-confirm "${testid}" — spec §5: the runner never clicks a price confirm. No such code path exists.`,
      );
    }
    const el = await waitPoll(() => {
      const e = q(testid);
      return e && isVisible(e) ? e : null;
    }, timeoutMs);
    if (!el) throw new Error(`click target "${testid}" never appeared within ${timeoutMs}ms`);
    el.scrollIntoView?.({ block: 'center' });
    el.click();
    return el;
  }

  async function typeInto(testid, text, timeoutMs = 10_000) {
    const el = await waitPoll(() => q(testid), timeoutMs);
    if (!el) throw new Error(`type target "${testid}" never appeared within ${timeoutMs}ms`);
    setFieldValue(el, text);
    return el;
  }

  const transcriptHas = (needle) => textOf('eb-transcript').includes(needle);
  const previewHas = (needle) => textOf('eb-preview').includes(needle);

  // Transcript turn introspection (§8.8 live grading, v0.2.4): the
  // app renders each transcript entry as a direct child of
  // eb-transcript — user turns and app notes as bare-text divs,
  // assistant replies as rows wrapping an avatar + bubble (element
  // children), the draft widget as eb-draft-widget, and the
  // composing indicator as eb-typing. Shape, not canned strings:
  // enough to tell "the user's turn was sent" from "an assistant
  // reply followed it" on a real account.
  function transcriptTurns() {
    const root = q('eb-transcript');
    if (!root) return [];
    return [...root.children].filter(
      (el) => el.getAttribute('data-testid') !== 'eb-typing',
    );
  }
  const isBareTurnEl = (el) =>
    el.childElementCount === 0 && (el.textContent ?? '').trim().length > 0;
  const isAssistantTurnEl = (el) =>
    el.childElementCount > 0 && el.getAttribute('data-testid') !== 'eb-draft-widget';
  const countSentTurns = (text) =>
    transcriptTurns().filter(
      (el) => isBareTurnEl(el) && (el.textContent ?? '').trim() === text,
    ).length;

  /** Show the saved-drafts rows when the card starts collapsed. */
  async function ensureDraftsOpen() {
    const toggle = q('eb-drafts-toggle');
    if (!toggle) return;
    if (toggle.getAttribute('aria-expanded') !== 'true') {
      toggle.click();
      await sleep(400);
    }
  }

  /** Click the "Open" button on the saved-draft row showing `name`. */
  async function openDraftByName(name, H) {
    await ensureDraftsOpen();
    const clicked = (() => {
      const card = q('eb-drafts');
      if (!card) return false;
      for (const btn of card.querySelectorAll('button')) {
        if (btn.textContent.trim() !== 'Open') continue;
        // Walk up to the row: the smallest ancestor that names this
        // draft and holds exactly this one Open button.
        let el = btn;
        for (let i = 0; i < 8 && el; i++) {
          el = el.parentElement;
          if (!el) break;
          const opens = [...el.querySelectorAll('button')].filter(
            (b) => b.textContent.trim() === 'Open',
          );
          if (opens.length === 1 && el.textContent.includes(name)) {
            if (!name.endsWith('copy') && el.textContent.indexOf(`${name} copy`) === 0) continue;
            btn.click();
            return true;
          }
        }
      }
      return false;
    })();
    if (!clicked) throw new Error(`could not find an Open button for draft “${name}”`);
    const ok = await waitPoll(
      () => (textOf('eb-current-draft').includes(name) ? true : null),
      10_000,
    );
    if (!ok) throw new Error(`draft “${name}” did not become the current draft`);
    H.note(`opened draft “${name}” (read-only)`);
  }

  /** Open a draft's ⋯ actions row (mirrors run.mjs). */
  async function ensureDraftMenuOpen(id) {
    if (q(`eb-draft-actions-${id}`)) return;
    await clickTestId(`eb-draft-menu-${id}`);
    await waitPoll(() => q(`eb-draft-actions-${id}`), 5_000);
  }

  // --- library rows -----------------------------------------------------
  // Draft identity comes from the row's own menu testid
  // (eb-draft-menu-<id>); the displayed name is the row's first span's
  // leading text. Ids are stable across rename; names are not.

  function rowForMenuBtn(btn) {
    let el = btn;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      // The row is the smallest ancestor holding exactly this one menu
      // button AND the name span; the buttons' own inner Group (one
      // level too low) has no span at all.
      if (
        el.querySelectorAll('[data-testid^="eb-draft-menu-"]').length === 1
        && el.querySelector('span')
      ) return el;
    }
    return null;
  }

  /** [{id, name}] for every draft row currently rendered. */
  function libraryDrafts() {
    return [...document.querySelectorAll('[data-testid^="eb-draft-menu-"]')].map((btn) => {
      const id = btn.getAttribute('data-testid').slice('eb-draft-menu-'.length);
      const row = rowForMenuBtn(btn);
      const nameNode = row?.querySelector('span')?.childNodes?.[0];
      return { id, name: (nameNode?.textContent ?? '').trim() };
    });
  }

  // --- scratch-draft lifecycle (§8.6, spec §5 containment) --------------
  // The ONLY code paths that click a draft's rename/duplicate/delete
  // controls live in this section, and every one of them first passes
  // assertScratchTarget: the draft id must be in this run's scratch
  // record AND the library must still show it under the recorded name.
  // A real draft cannot reach these controls through any handler.

  const SCRATCH_PREFIX = 'walk-scratch-';
  const scratchStamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  const scratchTargets = (ctx) => [ctx, ...(ctx?.copies ?? [])].filter(Boolean);

  function assertScratchTarget(ctx, id, expectedName, action) {
    const rec = scratchTargets(ctx).find((t) => t.id === id);
    if (!rec) {
      throw new Error(
        `GUARD (§5 containment): refusing to ${action} draft “${id}” — it is not in this run’s scratch record. Nothing was clicked.`,
      );
    }
    if (rec.name !== expectedName) {
      throw new Error(
        `GUARD (§5 containment): the scratch record calls draft ${id} “${rec.name}”, not “${expectedName}” — refusing to ${action}. Nothing was clicked.`,
      );
    }
    const live = libraryDrafts().find((d) => d.id === id);
    if (!live || live.name !== expectedName) {
      throw new Error(
        `GUARD (§5 containment): draft ${id} is not in the library as “${expectedName}” (found ${
          live ? `“${live.name}”` : 'no such draft'
        }) — refusing to ${action}. Nothing was clicked.`,
      );
    }
  }

  /** The single gate to the draft rename/duplicate/delete controls. */
  async function scratchControlClick(ctx, kind, id, expectedName) {
    await ensureDraftsOpen();
    assertScratchTarget(ctx, id, expectedName, `click ${kind}`);
    await ensureDraftMenuOpen(id);
    await clickTestId(`eb-${kind}-${id}`);
  }

  async function renameScratchDraft(ctx, id, fromName, toName) {
    await scratchControlClick(ctx, 'rename', id, fromName);
    await typeInto('eb-rename-input', toName);
    await clickTestId('eb-rename-save');
    const ok = await waitPoll(
      () => (libraryDrafts().find((d) => d.id === id)?.name === toName ? true : null),
      10_000,
    );
    if (!ok) throw new Error(`rename of scratch draft ${id} to “${toName}” did not stick in the library`);
  }

  async function duplicateScratchDraft(ctx, id, name) {
    await scratchControlClick(ctx, 'duplicate', id, name);
    const copyName = `${name} copy`;
    const copy = await waitPoll(() => {
      const found = libraryDrafts().find((d) => d.name === copyName && d.id !== id);
      return found ?? null;
    }, 10_000);
    if (!copy) throw new Error(`duplicate of “${name}” never produced “${copyName}” in the library`);
    return { id: copy.id, name: copyName };
  }

  async function deleteScratchDraft(ctx, id, name) {
    await scratchControlClick(ctx, 'delete', id, name); // arms “Confirm delete”
    await scratchControlClick(ctx, 'delete', id, name); // confirms
    const gone = await waitPoll(
      () => (libraryDrafts().some((d) => d.id === id) ? null : true),
      10_000,
    );
    if (!gone) throw new Error(`two-tap delete of “${name}” (${id}) did not remove it from the library`);
  }

  /**
   * Return this run's scratch record, creating the draft if needed:
   * New email → Save (so it enters the library) → rename to
   * walk-scratch-<timestamp> through the app's own rename UI. That
   * rename is the containment marker; only this draft (and copies the
   * ops step records) may be renamed/duplicated/deleted/saved.
   */
  async function ensureScratch(H, ctxIn) {
    if (ctxIn?.id) {
      await ensureDraftsOpen(); // rows must be rendered before identity checks
      assertScratchTarget(ctxIn, ctxIn.id, ctxIn.name, 'reuse the scratch draft');
      H.note(`reusing this run’s scratch draft “${ctxIn.name}” (${ctxIn.id}).`);
      return ctxIn;
    }
    await ensureDraftsOpen();
    const before = new Set(libraryDrafts().map((d) => d.id));
    H.note('creating this run’s scratch draft via New email (the editor’s previous unsaved draft is replaced, as with any draft open).');
    await clickTestId('eb-new');
    const headerFresh = await waitPoll(
      () => (textOf('eb-current-draft').includes('Untitled email') ? true : null),
      10_000,
    );
    H.check('“New email” opens a fresh Untitled draft', Boolean(headerFresh));
    await clickTestId('eb-save-draft');
    const created = await waitPoll(() => {
      const fresh = libraryDrafts().find((d) => !before.has(d.id));
      return fresh ?? null;
    }, 10_000);
    if (!created) {
      throw new Error('the new draft never appeared in the library after Save — scratch creation failed; fail-stop, nothing else was touched');
    }
    H.check('the new draft lands in the library as “Untitled email”', created.name === 'Untitled email');
    // Concurrent runs (v0.7.0) can stamp the same second. The name is
    // the containment marker, so it must be unique in this library:
    // wait for a free stamp rather than ever share one. A name still
    // taken after ~6s is a leftover from an earlier run — fail
    // honestly instead of adopting or overwriting it.
    let name = `${SCRATCH_PREFIX}${scratchStamp()}`;
    for (let waited = 0; libraryDrafts().some((d) => d.name === name && d.id !== created.id); waited += 250) {
      if (waited >= 6_000) {
        throw new Error(`a draft named “${name}” already exists in this library (a leftover scratch from an earlier run?) — refusing to share the containment marker; delete it by hand and re-run.`);
      }
      await sleep(250);
      name = `${SCRATCH_PREFIX}${scratchStamp()}`;
    }
    // Record the draft BEFORE the rename, so run-end cleanup can still
    // find and delete it by id if the rename itself fails.
    H.scratch = { id: created.id, name: created.name, copies: [] };
    await renameScratchDraft(H.scratch, created.id, created.name, name);
    H.scratch.name = name;
    const ctx = H.scratch;
    H.check(
      `draft renamed to the containment marker “${name}”`,
      libraryDrafts().find((d) => d.id === created.id)?.name === name,
    );
    H.note(`scratch draft for this run: “${name}” (${created.id}) — the only draft stateful steps may touch; deleted at run end (§5).`);
    return ctx;
  }

  /** Run-end cleanup: delete every recorded scratch draft, copies first. */
  async function cleanupScratch(ctx) {
    const result = { deleted: [], alreadyAbsent: [], failed: [] };
    if (!ctx?.id) return result;
    const targets = [...(ctx.copies ?? []), { id: ctx.id, name: ctx.name }];
    for (const target of targets) {
      try {
        await ensureDraftsOpen();
        if (!libraryDrafts().some((d) => d.id === target.id)) {
          result.alreadyAbsent.push(target.name);
          continue;
        }
        await deleteScratchDraft(ctx, target.id, target.name);
        result.deleted.push(target.name);
      } catch (err) {
        result.failed.push({
          id: target.id,
          name: target.name,
          error: String(err?.message ?? err).slice(0, 300),
        });
      }
    }
    return result;
  }

  const deadBannerShown = () =>
    Boolean(q('eb-banner-placeholder')) &&
    textOf('eb-banner-placeholder').includes('Banner image unavailable');

  /** Poll for the price-confirm card; a consent wall ends it first. */
  async function waitCardOrWall(timeoutMs = 30_000) {
    const found = await waitPoll(() => {
      const wall = consentWallText();
      if (wall) return { wall };
      return q('eb-confirm') ? { card: true } : null;
    }, timeoutMs);
    if (found?.wall) throw new ConsentWallError(found.wall);
    return found?.card ? q('eb-confirm') : null;
  }

  // --- page error capture (fail-stop evidence, recorded verbatim) ----
  const pageErrors = [];
  function pushPageError(text) {
    if (pageErrors.length >= 50) return;
    if (/favicon/.test(text)) return; // sandbox noise, not app signal (mirrors run.mjs)
    pageErrors.push(text.slice(0, 300));
  }
  window.addEventListener('error', (e) => {
    pushPageError(`pageerror: ${String(e?.message ?? e?.type ?? 'unknown')}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    pushPageError(`unhandledrejection: ${String(e?.reason?.message ?? e?.reason ?? 'unknown')}`);
  });
  // Console errors arrive via the panel-installed main-world hook
  // (installConsoleHook in panel.js), forwarded over window messages.
  window.addEventListener('message', (e) => {
    if (e?.data?.__tkConsole && typeof e.data.text === 'string') {
      pushPageError(`console: ${e.data.text}`);
    }
  });

  /** A dialog that is neither the price-confirm card nor harness chrome. */
  function surpriseDialogText() {
    for (const el of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
      if (!isVisible(el)) continue;
      if (el.closest('[data-testid="eb-confirm"], [data-testid="dc-confirm"], [data-testid="dc-lora-confirm"], [data-harness], [data-harness-banner]')) continue;
      if (el.querySelector('[data-testid="eb-confirm"], [data-testid="dc-confirm"], [data-testid="dc-lora-confirm"]')) continue;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (text) return text;
    }
    return null;
  }

  // --- Open Datasets binding helpers (§6 screens) ---------------------
  // Same discipline as the Email Builder side: state assertions read
  // from the page (counts, quotes, names as data), price cards are
  // reached and left for the user (or Auto), consent walls recorded
  // verbatim, and stateful steps touch only this run's
  // toil-scratch-* dataset, deleted at run end.

  /** The Open Datasets consent/host wall, verbatim, when one stands. */
  function odConsentText() {
    for (const id of ['dc-community-unavailable', 'dc-consent']) {
      const el = q(id);
      if (!el || !isVisible(el)) continue;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 500);
    }
    return null;
  }

  /** Walk the app's own back buttons until Explore renders. */
  async function odGoExplore() {
    for (let i = 0; i < 8; i++) {
      if (q('dc-explore-search') || q('dc-explore-empty')) return true;
      if (q('dc-lora')) { await clickTestId('dc-back-dataset-from-lora', 8_000).catch(() => {}); continue; }
      if (q('dc-train')) { await clickTestId('dc-back-dataset', 8_000).catch(() => {}); continue; }
      if (q('dc-ledger-view')) { await clickTestId('dc-back-explore-from-ledger', 8_000).catch(() => {}); continue; }
      if (q('dc-dataset-form')) { await clickTestId('dc-dataset-cancel', 8_000).catch(() => {}); continue; }
      if (q('dc-dataset-detail')) { await clickTestId('dc-back-explore', 8_000).catch(() => {}); continue; }
      await sleep(300);
    }
    return Boolean(q('dc-explore-search') || q('dc-explore-empty'));
  }

  async function odSetSearch(text) {
    const el = await waitPoll(() => q('dc-explore-search'), 10_000).catch(() => null);
    if (!el) return false;
    setFieldValue(el, text);
    await sleep(400);
    return true;
  }

  const odDatasetCards = () => [...document.querySelectorAll('[data-testid="dc-dataset-card"]')];

  function odOpenButtonForCard(card) {
    return card?.querySelector('[data-testid^="dc-open-dataset-"]') ?? null;
  }

  async function odOpenCard(card) {
    const btn = odOpenButtonForCard(card);
    if (!btn) return false;
    btn.scrollIntoView?.({ block: 'center' });
    btn.click();
    return Boolean(await waitPoll(() => q('dc-dataset-detail'), 12_000).catch(() => null));
  }

  /** Find an Explore card by dataset name; null when it does not list. */
  async function odFindCardByName(name) {
    await odSetSearch(name);
    return waitPoll(() => {
      const card = odDatasetCards().find((c) => (c.textContent ?? '').includes(name));
      return card ?? null;
    }, 8_000).catch(() => null);
  }

  /** Open a dataset by name from Explore; returns {id, name} or null. */
  async function odOpenDatasetByName(name) {
    const card = await odFindCardByName(name);
    if (!card) return null;
    const btn = odOpenButtonForCard(card);
    const id = btn?.getAttribute('data-testid')?.slice('dc-open-dataset-'.length) ?? null;
    const opened = await odOpenCard(card);
    return opened ? { id, name } : null;
  }

  /** This run's scratch dataset, or a §5 guard refusal. */
  function odScratchCtx(H) {
    const ctx = H.scratch;
    if (!ctx?.name?.startsWith('toil-scratch-')) {
      throw new Error('GUARD (§5 containment): no recorded toil-scratch-* dataset belongs to this run — nothing was touched.');
    }
    return ctx;
  }

  /**
   * Save the dataset form. The app wires storage lazily: the first
   * Save on a fresh context can be consumed by the storage-consent
   * attempt and leave the form open. Retrying once is what a user
   * does; a consent WALL is never clicked — it surfaces as the
   * unavailable/consent state and the wall detector ends the step.
   */
  async function odSaveDatasetForm(H) {
    await clickTestId('dc-dataset-save', 10_000);
    const done = () => (q('dc-dataset-detail') || q('dc-explore-search') || q('dc-explore-empty') ? true : null);
    let landed = await waitPoll(done, 6_000).catch(() => null);
    if (!landed && q('dc-dataset-form')) {
      H.note('dataset form still open after the first Save — retrying once (the first click may only have attempted the lazy storage write).');
      await clickTestId('dc-dataset-save', 10_000);
      landed = await waitPoll(done, 10_000).catch(() => null);
    }
    return Boolean(landed);
  }

  // --- the handler context handed to every in-page handler ------------
  function makeH(record, msg = null) {
    return {
      // True on real origins (and on the harness when the panel
      // forces the proof override): handlers take the account-shaped
      // live branches. False on the harness → byte-identical mock path.
      live: isLiveMode(msg),
      // Auto mode (v0.4.0): the user's panel opt-in, threaded per step
      // from the run's settings (read once at Run). Off by default.
      auto: msg?.autoRun === true,
      autoCapBuzz: Number.isFinite(msg?.autoCapBuzz) && msg.autoCapBuzz >= 0 ? msg.autoCapBuzz : 0,
      // This run's scratch-draft record ({id, name, copies}), carried
      // in from the panel and returned on the step record. Stateful
      // handlers mutate it; nothing else may.
      scratch: msg?.scratch ?? null,
      // Run-scoped handler flags, threaded the same way as `scratch`
      // (e.g. deadBannerRegen: the regenerate-confirm step armed the
      // dead-banner flow, so the outcome step may run for real).
      armed: msg?.armed && typeof msg.armed === 'object' ? { ...msg.armed } : {},
      check(label, ok) {
        record.checks.push({ label, ok: !!ok });
        if (!ok && record.status === 'pass') record.status = 'fail';
        sendProgress({ kind: 'check', stepId: record.id, label, ok: !!ok });
      },
      note(text) {
        record.notes.push(text);
        sendProgress({ kind: 'note', stepId: record.id, text });
      },
      // Liveness heartbeat during long state-aware working waits:
      // counted by the panel's dispatch clock, never recorded.
      heartbeat() {
        sendProgress({ kind: 'working', stepId: record.id });
      },
      // End the step as live-limited with an honest reason (used by
      // the detection-driven broken-banner steps, §8.6).
      liveLimit(reason) {
        record.status = 'live-limited';
        record.notes.push(`live-limited: ${reason}`);
        sendProgress({ kind: 'note', stepId: record.id, text: `live-limited: ${reason}` });
      },
      // Mid-step halt (§5): the handler has taken the flow as far as it
      // may go; a human must act in the page. Resolves 'resume' when
      // the panel says the user acted, 'end' when the run ends here.
      // `acted` (v0.2.4, optional): a page-side predicate for the act
      // the user was asked to perform. Some acts announce themselves
      // in the page (a clicked Send lands in the transcript) — when
      // the predicate sees it first, the park resolves 'resume' on
      // its own and the panel is told ('user-acted'), so no Resume
      // click is required. The panel's Resume/End stays authoritative
      // whenever it lands first; End/Stop still win over a late
      // predicate hit because only a still-open park is resolved.
      async awaitUser(reason, acted = null) {
        record.notes.push(`awaiting-user: ${reason}`);
        sendProgress({ kind: 'awaiting-user', stepId: record.id, reason });
        let observed = false;
        const decision = await new Promise((resolve) => {
          let finished = false;
          const finish = (d) => {
            if (finished) return;
            finished = true;
            resolve(d);
          };
          const park = { resolve: finish };
          walkCtl.awaiting = park;
          if (typeof acted === 'function') {
            (async () => {
              while (!finished && walkCtl.awaiting === park) {
                let hit = false;
                try { hit = Boolean(acted()); } catch { hit = false; }
                if (hit) {
                  if (walkCtl.awaiting === park) {
                    walkCtl.awaiting = null;
                    observed = true;
                    sendProgress({ kind: 'user-acted', stepId: record.id });
                    finish('resume');
                  }
                  return;
                }
                await sleep(400);
              }
            })();
          }
        });
        if (observed) {
          record.notes.push(
            'the user’s act was observed in the page — the runner resumed on its own (the click was the user’s; the runner still never clicks Send, §5).',
          );
        } else {
          record.notes.push(
            decision === 'resume'
              ? 'user acted in the page; runner resumed.'
              : 'run ended at the user-action point — the runner clicked nothing.',
          );
        }
        return decision;
      },
      waitPoll,
      clickTestId,
      typeInto,
      textOf,
      exists: (testid) => q(testid) !== null,
    };
  }

  /** Execute the data-expressible checks of an executor:"data" step. */
  async function runDataChecks(record, def, H) {
    for (const c of def.checks) {
      let ok = false;
      if (c.kind === 'exists') {
        ok = Boolean(await waitPoll(() => q(c.testid), CHECK_TIMEOUT_MS));
      } else if (c.kind === 'absent') {
        ok = Boolean(await waitPoll(() => (q(c.testid) ? null : true), CHECK_TIMEOUT_MS));
      } else if (c.kind === 'textContains') {
        ok = Boolean(
          await waitPoll(
            () => (textOf(c.testid).includes(c.text) ? true : null),
            CHECK_TIMEOUT_MS,
          ),
        );
      } else {
        H.check(`known check kind (${c.kind})`, false);
        continue;
      }
      H.check(c.label, ok);
    }
  }

  // ---------------------------------------------------------------------
  // Live-mode helpers (§8.8 calibration). On a real account there is
  // no seed: handlers find a draft whose CURRENT STATE qualifies,
  // assert against what that state actually shows, and end the step
  // `live-limited` (never `fail`) when no openable draft meets the
  // premise — an unmet account-state premise is not an app defect,
  // and live-limited does not fail-stop the run. Dependency skips
  // ride the run-scoped `armed` flags (panel-threaded like `scratch`).
  // ---------------------------------------------------------------------

  const PACKAGE_CHAIN_REASON =
    'no draft on this account shows a finished package (draft widget, banner image, or preview card) after scanning the open draft and up to 6 library drafts, so there is nothing for the preview chain to operate on (live-mode dependency skip — the mock walk owns the seeded version of this state).';

  /** Name of the currently open draft, matched against the library. */
  function currentRowName() {
    const header = textOf('eb-current-draft');
    return libraryDrafts().find((d) => d.name && header.includes(d.name))?.name ?? null;
  }

  /** A state snapshot of the currently open draft. */
  function readDraftState() {
    const placeholderText = textOf('eb-banner-placeholder').trim();
    const hasWidget = Boolean(q('eb-draft-widget'));
    const hasBannerImg = Boolean(q('eb-banner-img'));
    const hasPreview = Boolean(q('eb-preview'));
    return {
      briefText: textOf('eb-brief').trim().replace(/\s+/g, ' '),
      hasWidget,
      hasBannerImg,
      hasPreview,
      subjectCount: document.querySelectorAll('[data-testid^="eb-subject-"]').length,
      hasPackage: hasWidget || hasBannerImg || hasPreview,
      placeholderText,
      deadBanner: placeholderText.includes('Banner image unavailable'),
    };
  }

  /** Wait briefly for any draft-state marker, then snapshot. */
  async function settleDraftState(timeoutMs = 5_000) {
    await waitPoll(
      () => (readDraftState().hasPackage || readDraftState().briefText ? true : null),
      timeoutMs,
    ).catch(() => {});
    await sleep(300);
    return readDraftState();
  }

  const scannedSummary = (scanned) =>
    scanned
      .map((s) => `“${s.name}” (brief: “${s.brief || '—'}”, package: ${s.packaged ? 'yes' : 'no'})`)
      .join(' · ');

  /**
   * Find a draft whose state qualifies: try the currently open draft
   * first, then open up to `maxOpens` library drafts (read-only).
   * Returns { name, state, scanned } — state is null when nothing
   * qualifies. Draft names on a real account are DATA: they are
   * recorded, never asserted.
   */
  async function findQualifyingDraft(H, qualifies, maxOpens = 6) {
    await ensureDraftsOpen();
    const scanned = [];
    const consider = async (name) => {
      const st = await settleDraftState();
      scanned.push({
        name: name ?? '(currently open draft)',
        brief: st.briefText.slice(0, 60),
        packaged: st.hasPackage,
      });
      return qualifies(st) ? { name, state: st, scanned } : null;
    };
    const currentName = currentRowName();
    const hitCurrent = await consider(currentName);
    if (hitCurrent) {
      H.note(`using the currently open draft${currentName ? ` “${currentName}”` : ''} — its state qualifies (live-mode, read-only).`);
      return hitCurrent;
    }
    let opens = 0;
    for (const d of libraryDrafts()) {
      if (opens >= maxOpens) break;
      if (!d.name || d.name === currentName) continue;
      opens += 1;
      await openDraftByName(d.name, H);
      const hit = await consider(d.name);
      if (hit) return hit;
    }
    return { name: null, state: null, scanned };
  }

  /**
   * The preview chain's shared entry point: the draft this run
   * already matched (reopened if the page moved on), else the first
   * state-qualified draft. No qualifying draft anywhere → the whole
   * chain reports live-limited with one reason (dependency skip).
   */
  async function ensurePackageDraftOpen(H) {
    if (H.armed.packageChainLimited) {
      H.liveLimit(`dependency: finished-preview found no qualifying draft earlier in this run — ${H.armed.packageChainLimited}`);
      return null;
    }
    const armed = H.armed.packageDraft;
    if (armed) {
      if (!textOf('eb-current-draft').includes(armed)) await openDraftByName(armed, H);
      return armed;
    }
    const { name } = await findQualifyingDraft(H, (st) => st.hasPackage);
    if (!name) {
      H.armed.packageChainLimited = PACKAGE_CHAIN_REASON;
      H.liveLimit(PACKAGE_CHAIN_REASON);
      return null;
    }
    H.armed.packageDraft = name;
    return name;
  }

  /** Live first-run: shell + transcript; account state noted, never asserted. */
  async function runLiveFirstRun(H) {
    H.check('app shell renders', Boolean(await waitPoll(() => q('eb-app'), CHECK_TIMEOUT_MS)));
    H.check('transcript renders', Boolean(await waitPoll(() => q('eb-transcript'), CHECK_TIMEOUT_MS)));
    const header = textOf('eb-current-draft').trim().replace(/\s+/g, ' ').slice(0, 90);
    H.note(`current draft on this account: “${header || '(header empty)'}” — account state noted verbatim, never asserted (the seeded “Untitled email” greeting wording is a mock-only truth).`);
    H.note('live-mode first-run: the seeded greeting/fresh-draft assertions are not made on a real account; shell + transcript rendering is what is proven here.');
  }

  /**
   * Live post-send grading for the interview chat turn (v0.2.4). The
   * user sent the turn; grade what the ACCOUNT did with it, by state:
   * the typed turn present as a sent user turn, then an assistant
   * reply appended after it. The mock's honest no-reply note is never
   * the passing condition here — if the app answers with its own
   * note (or the repair offer) instead of a reply, there is no reply
   * to grade: the step ends live-limited with the app note verbatim
   * (settlement: a reply cannot be manufactured by the runner; on an
   * account where the model answers, this grades the reply itself).
   * A consent wall still ends the wait as live-limited: consent.
   */
  async function liveChatTurnOutcome(H, turnText, turnsBefore) {
    const outcome = await waitTerminalWorkingAware(() => {
      const wall = consentWallText();
      if (wall) return { wall };
      const turns = transcriptTurns();
      let sentIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isBareTurnEl(turns[i]) && (turns[i].textContent ?? '').trim() === turnText) {
          sentIdx = i;
          break;
        }
      }
      if (sentIdx === -1) return null; // not sent yet
      const after = turns.slice(sentIdx + 1);
      const reply = after.find((el) => isAssistantTurnEl(el));
      if (reply) return { sentIdx, reply: (reply.textContent ?? '').trim() };
      const note = after.find((el) => isBareTurnEl(el));
      if (note) return { sentIdx, noReply: (note.textContent ?? '').trim() };
      if (q('eb-repair-offer')) return { sentIdx, repair: true };
      return null; // still composing (typing row is filtered out)
    }, { softMs: 45_000, onWorking: () => H.heartbeat() });
    const terminal = outcome.hit;
    if (terminal?.wall) throw new ConsentWallError(terminal.wall);
    H.check(
      H.auto
        ? 'the typed turn is in the transcript (sent by the runner under Auto mode)'
        : 'the typed turn is in the transcript (sent by the user, never by the runner)',
      countSentTurns(turnText) > turnsBefore,
    );
    if (!terminal && outcome.ceilingHit) {
      H.liveLimit(
        `the turn was sent, but the app was still reporting working (eb-typing) after ` +
        `${Math.round(outcome.waitedMs / 1000)}s — the reply is not graded.`,
      );
    } else if (terminal?.reply) {
      H.check('an assistant reply followed the sent turn', true);
      H.note(`assistant replied (verbatim, first words): “${terminal.reply.slice(0, 140)}”`);
    } else if (terminal?.noReply || terminal?.repair) {
      const verbatim = terminal.noReply
        ?? 'the app raised its repair offer (eb-repair-offer) without a readable reply';
      H.liveLimit(
        `${H.auto ? 'the turn was auto-sent' : 'the user sent the turn'}, but no assistant reply followed to grade — the app answered with its own note instead: “${verbatim.slice(0, 220)}”. ` +
          'A reply cannot be manufactured by the runner; where the model answers, this step grades the reply itself.',
      );
    } else {
      H.check('an assistant reply followed the sent turn', false);
      const tail = transcriptTurns().slice(-2)
        .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100))
        .filter(Boolean).join(' | ');
      H.note(`nothing terminal landed within ${Math.round(outcome.waitedMs / 1000)}s (turn sent, still no reply) — transcript tail, verbatim: “${tail || '(empty)'}”.`);
    }
    const brief = textOf('eb-brief').trim().replace(/\s+/g, ' ').slice(0, 140);
    H.note(`brief after the turn, verbatim: “${brief || '(no brief card)'}” — account state, noted not asserted.`);
  }

  // --- live handlers (§8.8): state assertions, not seed strings -----

  async function liveSeededLibrary(H) {
    await ensureDraftsOpen();
    H.check('drafts card renders', Boolean(await waitPoll(() => q('eb-drafts'), CHECK_TIMEOUT_MS)));
    const drafts =
      (await waitPoll(() => {
        const rows = libraryDrafts();
        return rows.length > 0 ? rows : null;
      }, CHECK_TIMEOUT_MS)) ?? [];
    H.check(`library lists at least one real draft (${drafts.length} found)`, drafts.length >= 1);
    H.note(`library on this account lists ${drafts.length} draft(s): ${drafts.map((d) => `“${d.name}”`).join(' · ') || '(none)'} — names are recorded as data, not asserted (live-mode; the six seed names are a mock fixture).`);
  }

  async function liveInterviewDraftOpened(H) {
    const { name, state, scanned } = await findQualifyingDraft(H, (st) => !st.hasPackage);
    if (!state) {
      const reason = `no openable draft is mid-interview on this account (scanned: ${scannedSummary(scanned) || 'library empty'}) — every candidate already has a generated package, so the interview state cannot be shown without changing account data.`;
      H.armed.interviewLimited = reason;
      H.liveLimit(reason);
      return;
    }
    if (name) H.check('header names the opened draft', textOf('eb-current-draft').includes(name));
    else H.check('header shows the open draft', textOf('eb-current-draft').trim().length > 0);
    H.check('transcript renders the interview', textOf('eb-transcript').trim().length > 0);
    if (/in progress/i.test(state.briefText)) {
      H.check('brief is still “in progress”', true);
    } else if (state.briefText) {
      H.check(`brief badge read verbatim (“${state.briefText.slice(0, 60)}”)`, true);
    } else {
      H.note('no brief card on this draft yet (it appears once the interview produces one) — noted, not failed.');
    }
    H.check('no preview card before a package exists', !q('eb-preview'));
    H.note(`interview state read from draft “${name ?? '(currently open)'}” on this account (live-mode; the seeded draft name is not assumed).`);
  }

  async function liveBriefReady(H) {
    // The step's premise is a brief that just became ready and now
    // awaits its package — a ready draft that already generated is a
    // different state (its chat raises post-package controls, no
    // "generate my package" next step), so it does not qualify.
    const { name, state, scanned } = await findQualifyingDraft(
      H,
      (st) => /ready/i.test(st.briefText) && !st.hasPackage,
      8,
    );
    if (!state) {
      const reason = `no openable draft on this account has a ready brief waiting for its package (scanned: ${scannedSummary(scanned) || 'library empty'}) — ready drafts found already generated theirs, and the premise cannot be met without running an interview to completion.`;
      H.armed.briefReadyLimited = reason;
      H.liveLimit(reason);
      return;
    }
    H.note(`brief-ready state read from draft “${name ?? '(currently open)'}” (live-mode; opened read-only).`);
    H.check('brief badge reads “ready”', /ready/i.test(state.briefText));
    H.check(
      'chat raises the “generate my email package” next step',
      Boolean(await waitPoll(() => q('eb-next-generate'), CHECK_TIMEOUT_MS)),
    );
    H.check('no preview card before the package exists', !q('eb-preview'));
    const gen = q('eb-generate-bundle');
    if (gen) H.check('“Generate email package” is enabled', !gen.disabled);
    else H.note('no “Generate email package” button rendered on this draft (state noted verbatim, not failed).');
    if (name) H.armed.briefDraft = name;
  }

  async function liveFinishedPreview(H) {
    const { name, state, scanned } = await findQualifyingDraft(H, (st) => st.hasPackage);
    if (!state) {
      H.armed.packageChainLimited = PACKAGE_CHAIN_REASON;
      H.liveLimit(PACKAGE_CHAIN_REASON);
      H.note(`scanned: ${scannedSummary(scanned) || 'library empty'}.`);
      return;
    }
    H.armed.packageDraft = name;
    H.note(`preview chain operates on draft “${name ?? '(currently open)'}” — the first draft on this account showing a finished package (live-mode; the seeded name is not assumed).`);
    // The banner settles async (the mock waits 15s for the image
    // itself — do the same; never settle early on the placeholder,
    // which coexists with a still-loading image).
    await waitPoll(() => {
      const img = q('eb-banner-img');
      return img && isVisible(img) && img.complete ? img : null;
    }, 15_000).catch(() => {});
    const img = q('eb-banner-img');
    if (img) {
      H.check('banner image renders', Boolean(img.complete && img.naturalWidth > 0));
    } else if (q('eb-banner-placeholder')) {
      H.check('banner placeholder renders (this draft has no generated banner image)', true);
      H.note(`banner area shows the placeholder (“${textOf('eb-banner-placeholder').trim().slice(0, 120)}”) — read verbatim; a missing banner image is account state, not a failure.`);
    } else {
      H.check('banner image or placeholder renders in the preview', false);
    }
    H.check('preview shows the finished package', Boolean(q('eb-preview')));
    const subjectCount =
      (await waitPoll(() => {
        const n = document.querySelectorAll('[data-testid^="eb-subject-"]').length;
        return n >= 1 ? n : null;
      }, CHECK_TIMEOUT_MS).catch(() => null)) ??
      document.querySelectorAll('[data-testid^="eb-subject-"]').length;
    // A finished package offers subject options; how many is account
    // data (the seed offers several, this draft may offer one) — the
    // existence is asserted, the count recorded.
    H.check(`subject options offered (${subjectCount})`, subjectCount >= 1);
    H.check('draft widget is in the transcript', Boolean(q('eb-draft-widget')));
    H.note(`preview on this account’s draft: “${textOf('eb-preview').trim().replace(/\s+/g, ' ').slice(0, 120)}”`);
  }

  async function liveWidgetVariantSwitch(H) {
    const opened = await ensurePackageDraftOpen(H);
    if (!opened) return;
    const btn = await waitPoll(() => q('eb-widget-variant-variant-2'), CHECK_TIMEOUT_MS).catch(() => null);
    if (!btn) {
      H.liveLimit('the opened package offers no second widget variant (eb-widget-variant-variant-2 is not rendered), so the variant switch cannot be exercised on this account’s draft.');
      return;
    }
    const before = textOf('eb-preview');
    await clickTestId('eb-widget-variant-variant-2');
    const changed = await waitPoll(
      () => (textOf('eb-preview') !== before ? true : null),
      CHECK_TIMEOUT_MS,
    );
    H.check('preview follows the widget variant pick (preview text changed)', Boolean(changed));
    H.note(`preview before: “${before.trim().replace(/\s+/g, ' ').slice(0, 100)}” → after: “${textOf('eb-preview').trim().replace(/\s+/g, ' ').slice(0, 100)}” (compared live, not matched to seeded strings).`);
  }

  async function liveSubjectPick(H) {
    const opened = await ensurePackageDraftOpen(H);
    if (!opened) return;
    const buttons = await waitPoll(() => {
      const found = [...document.querySelectorAll('[data-testid^="eb-subject-"]')];
      return found.length > 0 ? found : null;
    }, CHECK_TIMEOUT_MS).catch(() => null);
    if (!buttons) {
      H.liveLimit('the opened package offers no subject options to pick (no eb-subject-* options are rendered).');
      return;
    }
    // App v0.1.12+: the copy editor (Subject field included) renders only
    // behind the "Edit copy" toggle. Open it before reading — like the
    // mock handler does — otherwise both reads sample an unmounted field
    // and report "" → "" on a healthy pick (seen on a live walk).
    if (!document.querySelector('[aria-label="Subject"]') && q('eb-edit-toggle')) {
      await clickTestId('eb-edit-toggle');
    }
    const before = document.querySelector('[aria-label="Subject"]')?.value ?? '';
    // Pick the first option that is not already in the editor, so the
    // pick can be shown to land; strings are read from the page.
    const target = buttons
      .map((b) => ({ testid: b.getAttribute('data-testid'), text: (b.textContent ?? '').trim().replace(/\s+/g, ' ') }))
      .find((o) => o.text && o.text !== before.trim());
    if (!target) {
      H.liveLimit(`the opened package’s subject option(s) already match the editor Subject (“${before.slice(0, 60)}”), so a pick cannot be shown to land on this draft.`);
      return;
    }
    await clickTestId(target.testid);
    // Poll until the editor shows the pick (or its tail), instead of
    // sampling once after a fixed sleep.
    const after = await waitPoll(() => {
      const v = document.querySelector('[aria-label="Subject"]')?.value ?? '';
      return v.length > 0 && (v === target.text || v.includes(target.text) || target.text.includes(v))
        ? v
        : null;
    }, CHECK_TIMEOUT_MS).catch(() => document.querySelector('[aria-label="Subject"]')?.value ?? '');
    H.check(
      'editor subject follows the pick',
      after !== before &&
        after.length > 0 &&
        (after === target.text || after.includes(target.text) || target.text.includes(after)),
    );
    H.note(`picked subject option “${target.text.slice(0, 80)}”; editor Subject went “${before.slice(0, 60)}” → “${after.slice(0, 60)}” (read from the page, not the seed).`);
  }

  async function liveBannerGenerateConfirm(H) {
    const { name, state } = await findQualifyingDraft(
      H,
      (st) => st.placeholderText.length > 0 && !st.deadBanner,
    );
    if (!state) {
      const reason = 'no openable draft on this account is waiting for a first banner generation (none shows the banner prompt placeholder) — the banner-generate premise cannot be manufactured without changing account data.';
      H.armed.bannerGenLimited = reason;
      H.liveLimit(reason);
      return;
    }
    H.armed.bannerDraft = name;
    H.check('no banner yet (prompt placeholder showing)', Boolean(q('eb-banner-placeholder')));
    await clickTestId('eb-banner-generate');
    const card = await waitCardOrWall(30_000);
    H.check('first generation asks for priced consent', Boolean(card));
    H.note(H.auto ? 'card reached; Auto mode will confirm it if priced at/under the cap.' : 'card reached; the runner will not click it (§5).');
  }

  // ---------------------------------------------------------------------
  // In-page handlers. Ported from tools/walk/run.mjs HANDLERS with the
  // same assertions; puppeteer calls become DOM calls, and anything
  // that would continue a spend is replaced by the §5 halt (the user
  // clicks in the page; the outcome steps below only read the result).
  // Stateful steps run only on this run's walk-scratch draft (§8.6).
  // On live origins (H.live) the read-only handlers take the
  // account-shaped branches above; the mock bodies are untouched.
  // ---------------------------------------------------------------------

  const IN_PAGE_HANDLERS = {
    seededLibrary: async (H) => {
      if (H.live) return liveSeededLibrary(H);
      await ensureDraftsOpen();
      const library = textOf('eb-drafts');
      for (const name of [
        'Spring sale announcement',
        'Webinar invite',
        'Spring launch announcement', // the screenshot rig's own demo draft
        'October newsletter',
        'Dark mode launch',
        'Product tips digest',
      ]) {
        H.check(`library lists “${name}”`, library.includes(name));
      }
    },

    interviewDraftOpened: async (H) => {
      if (H.live) return liveInterviewDraftOpened(H);
      await openDraftByName('Dark mode launch', H);
      H.check(
        'header names the opened draft',
        textOf('eb-current-draft').includes('Dark mode launch'),
      );
      H.check('brief is still “in progress”', textOf('eb-brief').includes('in progress'));
      H.check('no preview card before a package exists', !q('eb-preview'));
      H.check(
        'transcript shows the seeded interview turns',
        textOf('eb-transcript').includes('Beta users first'),
      );
    },

    // Priced on live (§6: "runner types, stops at send/confirm"). The
    // runner types the turn and halts BEFORE Send; the user clicks
    // Send in the page. Post-send assertions then run — the runner
    // still never clicks Send or a confirm itself.
    interviewChatTurn: async (H) => {
      if (H.live && H.armed.interviewLimited) {
        H.liveLimit(`dependency: interview-draft-opened found no mid-interview draft earlier in this run — ${H.armed.interviewLimited}`);
        return;
      }
      const TURN_TEXT = 'One more thing: keep it under five sentences';
      await typeInto('eb-chat-input', TURN_TEXT);
      if (H.auto) {
        // Auto mode (v0.4.0): the user opted out of the wait on the
        // panel for this run, so the runner clicks Send itself and
        // grades what follows exactly as after a user's Send. This is
        // the ONLY Send click in the executor, behind msg.autoRun.
        H.note('Auto mode: Send clicked by the runner (user opt-in — no wait).');
        const turnsBeforeAuto = countSentTurns(TURN_TEXT);
        await clickTestId('eb-send');
        if (H.live) {
          await liveChatTurnOutcome(H, TURN_TEXT, turnsBeforeAuto);
          return;
        }
        await waitPoll(
          () => q('eb-repair-offer') || transcriptHas('try sending again') || consentWallText(),
          45_000,
        ).catch(() => {});
        const wallAuto = consentWallText();
        if (wallAuto) throw new ConsentWallError(wallAuto);
        const transcriptAuto = textOf('eb-transcript');
        H.check(
          'transcript records the honest no-reply note',
          transcriptAuto.includes('didn’t reply') || transcriptAuto.includes('shape I couldn’t read'),
        );
        return;
      }
      H.note('chat turn typed. The runner never clicks Send (§5) — halting for the user.');
      // Live only (v0.2.4): the user's act is visible in the page —
      // the typed text lands in the transcript as a sent user turn.
      // Count pre-existing identical turns first, so a repeat run's
      // older copy cannot trip the auto-resume.
      const turnsBefore = H.live ? countSentTurns(TURN_TEXT) : 0;
      const decision = await H.awaitUser(
        H.live
          ? 'A chat turn is typed but not sent. Click “Send” in the app yourself — the runner will see the sent turn and continue on its own (Resume also works) — or End run here.'
          : 'A chat turn is typed but not sent. Click “Send” in the app yourself, then Resume — or End run here.',
        H.live ? () => countSentTurns(TURN_TEXT) > turnsBefore : null,
      );
      if (decision === 'end') {
        H.note('turn left typed and unsent; nothing was sent by the runner.');
        return;
      }
      if (H.live) {
        await liveChatTurnOutcome(H, TURN_TEXT, turnsBefore);
        return;
      }
      // Terminal = an honest outcome note lands in the transcript (the
      // mock's empty snapshot lands on “didn’t reply”; an unreadable one
      // would land on the repair offer instead). A consent wall ends the
      // wait first (§8.6): the step goes live-limited, not failed.
      await waitPoll(
        () => q('eb-repair-offer') || transcriptHas('try sending again') || consentWallText(),
        45_000,
      ).catch(() => {});
      const wallNow = consentWallText();
      if (wallNow) throw new ConsentWallError(wallNow);
      const transcript = textOf('eb-transcript');
      H.check(
        'transcript records the honest no-reply note',
        transcript.includes('didn’t reply') || transcript.includes('shape I couldn’t read'),
      );
      H.note(
        transcript.includes('didn’t reply')
          ? 'mock snapshot carried no text; the app charged-note path rendered in-transcript'
          : 'unreadable-reply path rendered',
      );
    },

    briefReady: async (H) => {
      if (H.live) return liveBriefReady(H);
      await openDraftByName('October newsletter', H);
      H.check('brief badge reads “ready”', textOf('eb-brief').includes('ready'));
      H.check(
        'chat raises the “generate my email package” next step',
        Boolean(await waitPoll(() => q('eb-next-generate'), CHECK_TIMEOUT_MS)),
      );
      H.check('no preview card before the package exists', !q('eb-preview'));
      const gen = q('eb-generate-bundle');
      H.check('“Generate email package” is enabled', Boolean(gen) && !gen.disabled);
    },

    // Reaches the price-confirm card and stops (§5). The executor's
    // post-step gate sees the open card and halts the run there. A
    // consent wall in place of the card ends it live-limited instead.
    bundleConfirm: async (H) => {
      if (H.live && H.armed.briefReadyLimited) {
        H.armed.bundleChainLimited = H.armed.briefReadyLimited;
        H.liveLimit(`dependency: brief-ready found no qualifying draft earlier in this run — ${H.armed.briefReadyLimited}`);
        return;
      }
      if (H.live && H.armed.briefDraft && !textOf('eb-current-draft').includes(H.armed.briefDraft)) {
        await openDraftByName(H.armed.briefDraft, H);
      }
      await clickTestId('eb-generate-bundle');
      const card = await waitCardOrWall(30_000);
      H.check('price-confirm card appears', Boolean(card));
      H.check('confirm card names the Buzz price', textOf('eb-confirm').includes('Buzz'));
      H.note(H.auto ? 'card reached; Auto mode will confirm it if priced at/under the cap.' : 'card reached; the runner will not click it (§5).');
    },

    // Behind the panel's awaiting-user gate (§8.6): runs only after
    // the user clicked Confirm in the page themselves (or pressed
    // Continue without doing so — then the assertions fail honestly).
    // The runner clicks nothing here; it reads the outcome, mirroring
    // run.mjs's post-confirm checks minus the confirm click itself.
    bundleOutcome: async (H) => {
      if (H.live && H.armed.bundleChainLimited) {
        H.liveLimit(`dependency: the bundle chain never reached a priced confirm earlier in this run — ${H.armed.bundleChainLimited}`);
        return;
      }
      const outcome = await waitTerminalWorkingAware(() => {
        const wall = consentWallText();
        if (wall) return { wall };
        // The outcome counts only once the confirm card is gone —
        // while it stands, the spend has not happened, and a stale
        // repair-offer/transcript phrase from an earlier turn must
        // not read as this step's terminal state (the instant Auto
        // confirm path races exactly that).
        if (q('eb-confirm')) return null;
        return q('eb-draft-widget') ||
          q('eb-repair-offer') ||
          textOf('eb-notice').length > 0 ||
          transcriptHas('shape I couldn’t read')
          ? { done: true }
          : null;
      }, { softMs: 60_000, onWorking: () => H.heartbeat() });
      const terminal = outcome.hit;
      if (terminal?.wall) throw new ConsentWallError(terminal.wall);
      H.check('confirm card is dismissed', !q('eb-confirm'));
      let notice = textOf('eb-notice');
      let widget = Boolean(q('eb-draft-widget'));
      if (!widget && !notice.trim() && outcome.ceilingHit) {
        // The card was dismissed, so its Buzz was spent at confirm —
        // but the app was still reporting working when the state-
        // aware ceiling ran out. The outcome is unknown, not failed:
        // grade live-limited and say so (never pass, never imply the
        // spend did not happen).
        H.liveLimit(
          `the confirm card was dismissed (its Buzz was spent at confirm), but the app was still ` +
          `reporting working (eb-typing) after ${Math.round(outcome.waitedMs / 1000)}s — the generation ` +
          'outcome is unknown; the run did not wait longer and does not grade it. Check the draft in the app.',
        );
        return;
      }
      if (!widget && !notice.trim()) {
        // The terminal marker (repair offer) can land a beat before
        // the app finishes saying what happened; grade the settled
        // state, not the race (the instant Auto path hits this).
        await waitPoll(
          () => q('eb-draft-widget') || textOf('eb-notice').trim().length > 0,
          8_000,
        ).catch(() => {});
        notice = textOf('eb-notice');
        widget = Boolean(q('eb-draft-widget'));
      }
      H.check('an honest terminal state is reached', widget || notice.trim().length > 0);
      if (outcome.sawWorking) {
        H.note(`waited ~${Math.round(outcome.waitedMs / 1000)}s while the app reported working (eb-typing) before grading the outcome.`);
      }
      H.note(widget ? 'a draft widget appeared' : `terminal notice: “${notice.trim()}”`);
    },

    finishedPreview: async (H) => {
      if (H.live) return liveFinishedPreview(H);
      await openDraftByName('Spring sale announcement', H);
      await waitPoll(() => {
        const img = q('eb-banner-img');
        return img && isVisible(img) ? img : null;
      }, 15_000);
      const img = q('eb-banner-img');
      H.check(
        'seeded banner image renders',
        Boolean(img) && img.complete && img.naturalWidth > 0,
      );
      H.check(
        'preview shows the selected variant headline',
        previewHas('Spring refresh: up to 40% off'),
      );
      const subjectCount = document.querySelectorAll('[data-testid^="eb-subject-"]').length;
      H.check(`subject options offered (${subjectCount})`, subjectCount >= 2);
      H.check('draft widget is in the transcript', Boolean(q('eb-draft-widget')));
    },

    widgetVariantSwitch: async (H) => {
      if (H.live) return liveWidgetVariantSwitch(H);
      await clickTestId('eb-widget-variant-variant-2');
      await waitPoll(() => previewHas('40% off. Until Sunday.'), 10_000);
      H.check(
        'preview follows the widget variant pick',
        previewHas('40% off. Until Sunday.'),
      );
    },

    subjectPick: async (H) => {
      if (H.live) return liveSubjectPick(H);
      await clickTestId('eb-subject-1');
      // App v0.1.12: the copy editor (Subject field included) sits
      // behind the “Edit copy” toggle — open it like a user would
      // when the field isn't rendered yet.
      if (!document.querySelector('[aria-label="Subject"]') && q('eb-edit-toggle')) {
        await clickTestId('eb-edit-toggle');
      }
      // Poll, don't guess: a fixed 300ms sleep raced the app's state
      // under load and failed deterministically on a loaded machine.
      const subject = await waitPoll(() => {
        const v = document.querySelector('[aria-label="Subject"]')?.value ?? '';
        return v === 'Your upgrade is 40% off until Sunday' ? v : null;
      }, 5_000);
      H.check('editor subject follows the pick', subject === 'Your upgrade is 40% off until Sunday');
    },

    manualEditPreview: async (H) => {
      if (H.live) {
        const opened = await ensurePackageDraftOpen(H);
        if (!opened) return;
        H.note('manual edit asserted by its re-render on this account’s draft (live-mode) — the marker text is the runner’s own.');
      }
      // App v0.1.12: headline editor is behind “Edit copy” too.
      if (!q('eb-headline') && q('eb-edit-toggle')) await clickTestId('eb-edit-toggle');
      // run.mjs used Ctrl+A + type; setting the field value through the
      // React-safe setter is the same edit from the app's point of view.
      await typeInto('eb-headline', 'Edited live in the walk');
      await waitPoll(() => previewHas('Edited live in the walk'), 10_000);
      H.check(
        'preview re-renders the manual headline edit',
        previewHas('Edited live in the walk'),
      );
    },

    exportCopy: async (H) => {
      if (H.live) {
        const opened = await ensurePackageDraftOpen(H);
        if (!opened) return;
      }
      await clickTestId('eb-copy-html');
      // The clipboard write in the sandboxed live frame can settle
      // slowly (or be refused after a delay); poll for any of the
      // app's honest outcomes instead of sampling once at 800ms —
      // a single early sample reported no outcome on a healthy
      // click in live walk-2026-10-08-2328.
      await waitPoll(() => {
        const f = textOf('eb-flash');
        const n = textOf('eb-notice');
        const l = textOf('eb-copy-html');
        return f.includes('HTML copied') || n.includes('Copy was blocked') || l.includes('Copied')
          ? true
          : null;
      }, 12_000).catch(() => null);
      const flash = textOf('eb-flash');
      const notice = textOf('eb-notice');
      const copiedLabel = textOf('eb-copy-html');
      H.check(
        'copy gives an honest outcome (flash, Copied label, or blocked notice)',
        flash.includes('HTML copied') || copiedLabel.includes('Copied') || notice.includes('Copy was blocked'),
      );
      H.note(
        flash.includes('HTML copied')
          ? 'clipboard write succeeded; flash shown'
          : notice.includes('Copy was blocked')
            ? 'clipboard blocked here; the app’s fallback notice shown'
            : `copy outcome label: “${copiedLabel.trim()}”`,
      );
    },

    // Same shape as bundleConfirm, for the banner flow (§5 stop).
    bannerGenerateConfirm: async (H) => {
      if (H.live) return liveBannerGenerateConfirm(H);
      await openDraftByName('Product tips digest', H);
      H.check('no banner yet (prompt placeholder showing)', Boolean(q('eb-banner-placeholder')));
      await clickTestId('eb-banner-generate');
      const card = await waitCardOrWall(30_000);
      H.check('first generation asks for priced consent', Boolean(card));
      H.note(H.auto ? 'card reached; Auto mode will confirm it if priced at/under the cap.' : 'card reached; the runner will not click it (§5).');
    },

    // Behind the awaiting-user gate, like bundleOutcome: the user
    // clicked Confirm in the page; this reads the result. run.mjs
    // waits 30s; 60s here because live inference is slower than the
    // mock's canned reply (divergence noted in the design note).
    bannerGenerated: async (H) => {
      if (H.live && H.armed.bannerGenLimited) {
        H.liveLimit(`dependency: banner-generate-confirm found no draft waiting for a first banner earlier in this run — ${H.armed.bannerGenLimited}`);
        return;
      }
      H.note('banner pixels are whatever the host generated; on the mock they are its canned placeholder.');
      const outcome = await waitTerminalWorkingAware(() => {
        const wall = consentWallText();
        if (wall) return { wall };
        return q('eb-banner-img') ? { img: true } : null;
      }, { softMs: 60_000, onWorking: () => H.heartbeat() });
      const got = outcome.hit;
      if (got?.wall) throw new ConsentWallError(got.wall);
      if (!got && outcome.ceilingHit) {
        H.liveLimit(
          `the banner generation was still reporting working (eb-typing) after ` +
          `${Math.round(outcome.waitedMs / 1000)}s — its outcome is unknown and is not graded.`,
        );
        return;
      }
      if (outcome.sawWorking) {
        H.note(`waited ~${Math.round(outcome.waitedMs / 1000)}s while the app reported working (eb-typing) before grading the banner.`);
      }
      H.check('generated banner lands in the preview', Boolean(got?.img));
    },

    // Broken-banner trio, detection-driven (§8.6 settlement): they run
    // for real only when the open draft already shows the dead-banner
    // placeholder; otherwise they report live-limited with the reason.
    brokenBannerFallback: async (H) => {
      const shown = await waitPoll(() => (deadBannerShown() ? true : null), 10_000);
      if (!shown) {
        H.liveLimit(DEAD_BANNER_SETTLEMENT);
        return;
      }
      H.check(
        'dead banner URL degrades to the “unavailable” placeholder',
        textOf('eb-banner-placeholder').includes('Banner image unavailable'),
      );
      H.check('regenerate is offered in place', Boolean(q('eb-banner-regenerate')));
    },

    brokenBannerRegenerateConfirm: async (H) => {
      const shown = await waitPoll(() => (deadBannerShown() ? true : null), 8_000);
      if (!shown) {
        H.liveLimit(DEAD_BANNER_SETTLEMENT);
        return;
      }
      await clickTestId('eb-banner-regenerate');
      const card = await waitCardOrWall(30_000);
      H.check('regenerate asks for priced consent first', Boolean(card));
      // Arm the outcome step: only a run that actually reached this
      // priced gate may assert the regenerated banner. Without the arm
      // (or a placeholder still on screen), brokenBannerRegenerated
      // reports live-limited instead of passing on some other draft's
      // healthy banner.
      H.armed.deadBannerRegen = true;
      H.note(H.auto ? 'card reached; Auto mode will confirm it if priced at/under the cap.' : 'card reached; the runner will not click it (§5).');
    },

    brokenBannerRegenerated: async (H) => {
      // Runs for real only when the dead-banner flow was actually
      // armed: the regenerate-confirm step reached the priced gate in
      // this run, or the placeholder is still on screen. (A healthy
      // banner on whatever draft happens to be open proves nothing.)
      if (!H.armed.deadBannerRegen && !deadBannerShown()) {
        H.liveLimit(DEAD_BANNER_SETTLEMENT);
        return;
      }
      // Behind the awaiting-user gate: the user's own Confirm started
      // the regeneration; the runner only reads where it landed.
      const got = await waitPoll(() => {
        const wall = consentWallText();
        if (wall) return { wall };
        return q('eb-banner-img') ? { img: true } : null;
      }, 45_000);
      if (got?.wall) throw new ConsentWallError(got.wall);
      H.check('a fresh banner image replaces the dead one', Boolean(got?.img));
      H.note('on the mock the fresh pixels are the host’s canned placeholder; live they are the real generation.');
    },

    // Stateful steps (§5 containment): everything below touches only
    // this run's walk-scratch draft, behind the id+name guard.
    saveAndNew: async (H) => {
      const ctx = await ensureScratch(H, H.scratch);
      H.scratch = ctx;
      await openDraftByName(ctx.name, H);
      // eb-save-draft persists whichever draft is open, so it is
      // clicked only when the open draft verifiably IS the scratch.
      if (!textOf('eb-current-draft').includes(ctx.name)) {
        throw new Error(
          `GUARD (§5 containment): the open draft is not this run’s scratch draft “${ctx.name}” — Save was not clicked.`,
        );
      }
      await clickTestId('eb-save-draft');
      const saved = await waitPoll(
        () => (textOf('eb-flash').includes('Saved') ? true : null),
        10_000,
      );
      H.check('Save confirms with a flash', Boolean(saved));
      await clickTestId('eb-new');
      const fresh = await waitPoll(
        () => (textOf('eb-current-draft').includes('Untitled email') ? true : null),
        10_000,
      );
      H.check('“New email” resets to a fresh draft', Boolean(fresh));
      H.note('the draft after “New email” is unsaved and unlisted — only the scratch draft ever enters the library, and run-end cleanup deletes it.');
    },

    draftsLibraryOps: async (H) => {
      const ctx = await ensureScratch(H, H.scratch);
      H.scratch = ctx;
      const copy = await duplicateScratchDraft(ctx, ctx.id, ctx.name);
      ctx.copies = [...(ctx.copies ?? []), copy];
      H.scratch = ctx;
      H.check(
        `duplicate adds “${copy.name}”`,
        libraryDrafts().some((d) => d.id === copy.id && d.name === copy.name),
      );
      const renamedName = `${ctx.name} (renamed)`;
      await renameScratchDraft(ctx, copy.id, copy.name, renamedName);
      const copyRec = ctx.copies.find((c) => c.id === copy.id);
      if (copyRec) copyRec.name = renamedName;
      H.scratch = ctx;
      H.check(
        'rename sticks in the library',
        libraryDrafts().find((d) => d.id === copy.id)?.name === renamedName,
      );
      await deleteScratchDraft(ctx, copy.id, renamedName);
      ctx.copies = ctx.copies.filter((c) => c.id !== copy.id);
      H.scratch = ctx;
      H.check(
        'two-tap delete removes the renamed copy',
        !libraryDrafts().some((d) => d.id === copy.id),
      );
      H.note(`duplicate / rename / delete ran on scratch drafts only (“${ctx.name}” and its copy); the scratch original remains for run-end cleanup.`);
    },
  };

  // Kept as a literal name list so tools/walk/sync-steps.mjs can print
  // handler coverage without executing this file.
  const IN_PAGE_HANDLER_NAMES = [
    'seededLibrary', 'interviewDraftOpened', 'interviewChatTurn', 'briefReady',
    'bundleConfirm', 'bundleOutcome', 'finishedPreview', 'widgetVariantSwitch',
    'subjectPick', 'manualEditPreview', 'exportCopy', 'bannerGenerateConfirm',
    'bannerGenerated', 'brokenBannerFallback', 'brokenBannerRegenerateConfirm',
    'brokenBannerRegenerated', 'saveAndNew', 'draftsLibraryOps',
  ];

  // --- Open Datasets in-page handlers (all six screens) ---------------
  const OD_HANDLERS = {
    odExplore: async (H) => {
      await waitPoll(
        () => q('dc-explore-search') || q('dc-explore-empty') || q('dc-community-unavailable'),
        15_000,
      ).catch(() => {});
      const wall = odConsentText();
      if (wall && q('dc-community-unavailable')) throw new ConsentWallError(wall);
      H.check('Explore renders (search or honest empty state)', Boolean(q('dc-explore-search') || q('dc-explore-empty')));
      H.check('Explore search is present', Boolean(q('dc-explore-search')));
      H.check('Explore sort is present', Boolean(q('dc-explore-sort')));
      H.check('Create dataset action is present', Boolean(q('dc-create-dataset')));
      const cards = odDatasetCards();
      H.check(
        `Explore shows datasets or the honest empty state (${cards.length} dataset card(s))`,
        cards.length > 0 || Boolean(q('dc-explore-empty')),
      );
      if (cards.length) {
        H.note(`Explore lists ${cards.length} dataset card(s); first, verbatim: “${(cards[0].textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)}” — names are data, not assertions.`);
      } else if (q('dc-explore-empty')) {
        H.note('Explore is honestly empty on this account — the empty state is the assertion.');
      }
    },

    odDatasetDetail: async (H) => {
      await odGoExplore();
      const cards = odDatasetCards();
      if (!cards.length) {
        H.liveLimit('no dataset exists on this account to open read-only; dataset detail cannot be shown without creating data outside a scratch step.');
        return;
      }
      const opened = await odOpenCard(cards[0]);
      H.check('dataset detail renders', Boolean(opened && q('dc-dataset-detail')));
      H.check('Train (or first-image) action is present', Boolean(q('dc-open-train') || q('dc-add-first-image')));
      const items = document.querySelectorAll('[data-testid^="dc-item-card-"]').length;
      H.note(`dataset detail shows ${items} item card(s) — counts are account state, noted not asserted. Real datasets are opened read-only: no votes, edits, or removals.`);
      await odGoExplore();
      H.check('returns to Explore', Boolean(q('dc-explore-search') || q('dc-explore-empty')));
    },

    odScratchCreate: async (H) => {
      await odGoExplore();
      const wall = odConsentText();
      if (wall && q('dc-community-unavailable')) throw new ConsentWallError(wall);
      await clickTestId(q('dc-create-dataset') ? 'dc-create-dataset' : 'dc-create-first-dataset', 10_000);
      await waitPoll(() => q('dc-dataset-form'), 10_000);
      // Concurrent runs (v0.7.0) can stamp the same second; the run
      // suffix keeps every run's containment marker unique even when
      // two runs share one account — names are never shared.
      const runSuffix = String(walkCtl.runId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'run';
      const name = `toil-scratch-${scratchStamp()}-${runSuffix}`;
      // Recorded BEFORE the save lands, so run-end cleanup still has
      // its target if a later check fails.
      H.scratch = { appId: 'open-datasets', id: name, name, itemIds: [] };
      await typeInto('dc-dataset-name', name);
      await typeInto('dc-dataset-description', 'Run-scoped Toil-Killer scratch dataset — created, exercised, and deleted by a single Toil-Killer walk.');
      await typeInto('dc-dataset-target', 'SDXL character LoRA');
      await odSaveDatasetForm(H);
      H.check('scratch dataset detail renders under its containment name', textOf('dc-dataset-detail').includes(name));
      H.note(`scratch dataset for this run: “${name}” — the only dataset stateful steps may touch; deleted at run end (§5).`);
    },

    odScratchEditContribute: async (H) => {
      const ctx = odScratchCtx(H);
      await odGoExplore();
      if (!textOf('dc-dataset-detail').includes(ctx.name)) {
        const found = await odOpenDatasetByName(ctx.name);
        if (found?.id) { ctx.id = found.id; H.scratch = ctx; }
      }
      await clickTestId('dc-edit-dataset', 10_000);
      await waitPoll(() => q('dc-dataset-form'), 10_000);
      await typeInto('dc-dataset-target', 'SDXL character LoRA — exercised by the Toil-Killer walk; deleted at run end.');
      await odSaveDatasetForm(H);
      H.check('edited scratch dataset detail renders', textOf('dc-dataset-detail').includes(ctx.name));
      // Contribute TWO distinct items to the scratch dataset (the
      // #541 reviewer pushed back on one-item evidence): distinct
      // Civitai consumer-blob references and distinct captions (the
      // mock trainer assembles them; on live, Train reports honestly
      // if it cannot). The runner never uploads a file for the user.
      const refs = [
        `https://civitai.com/v2/consumer/blobs/${ctx.name}`,
        `https://civitai.com/v2/consumer/blobs/${ctx.name}-b`,
      ];
      const captions = ['toil scratch image, front view', 'toil scratch image, side view'];
      const itemIds = [];
      const blobRefs = {};
      const contributorByItem = {};
      for (let idx = 0; idx < refs.length; idx++) {
        let itemId = null;
        for (let attempt = 0; attempt < 2 && !itemId; attempt++) {
          await typeInto('dc-contribute-ref', refs[idx]);
          await typeInto('dc-contribute-caption', captions[idx]);
          const rights = q('dc-contribute-rights');
          if (rights && !rights.checked) rights.click();
          await clickTestId('dc-contribute-submit', 10_000);
          itemId = await waitPoll(() => {
            const els = [...document.querySelectorAll('[data-testid^="dc-item-card-"]')];
            const fresh = els.map((el) => el.getAttribute('data-testid').slice('dc-item-card-'.length)).find((id) => !itemIds.includes(id));
            return fresh ?? null;
          }, 10_000).catch(() => null);
        }
        if (itemId) { itemIds.push(itemId); blobRefs[itemId] = refs[idx]; }
      }
      H.check('both contributed scratch items land on the dataset', itemIds.length === 2, itemIds.join(', '));
      ctx.itemIds = itemIds;
      ctx.blobRefs = blobRefs;
      H.scratch = ctx;
      // Vote each of the viewer's own scratch items trainable (net +1
      // feeds the training snapshot). Retry once while not landed.
      const readNet = (id) => {
        const n = Number.parseInt((textOf(`dc-item-${id}-net`) ?? '').replace(/[^-\d]/g, ''), 10);
        return Number.isFinite(n) ? n : null;
      };
      for (const itemId of itemIds) {
        let net = readNet(itemId);
        for (let i = 0; i < 2 && net !== 1; i++) {
          await clickTestId(`dc-item-${itemId}-up`, 8_000).catch(() => {});
          await sleep(600);
          net = readNet(itemId);
        }
        H.check(`own scratch item ${itemId} voted trainable (net ${net ?? '?'})`, net === 1);
        const card = document.querySelector(`[data-testid="dc-item-card-${itemId}"]`);
        contributorByItem[itemId] = (card?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      }
      ctx.contributorByItem = contributorByItem;
      H.scratch = ctx;
      // Resolve the real dataset id from Explore for the record.
      await odGoExplore();
      const found = await odOpenDatasetByName(ctx.name);
      if (found?.id) { ctx.id = found.id; H.scratch = ctx; }
      H.note(`scratch dataset “${ctx.name}” (id ${ctx.id}) edited + ${ctx.itemIds.length} items contributed and voted — the only dataset stateful steps touch; deleted at run end (§5). Per-item contributor text as shown on the dataset cards: ${ctx.itemIds.map((id) => `${id}: "${ctx.contributorByItem?.[id] ?? ''}" (blob ref ${ctx.blobRefs?.[id] ?? ''})`).join(' · ')}`);
    },

    odTrainConfirm: async (H) => {
      const ctx = odScratchCtx(H);
      if (!textOf('dc-dataset-detail').includes(ctx.name)) {
        await odGoExplore();
        await odOpenDatasetByName(ctx.name);
      }
      await clickTestId('dc-open-train', 10_000);
      H.check('Train screen renders', Boolean(await waitPoll(() => q('dc-train'), 12_000).catch(() => null)));
      const ids = ctx.itemIds ?? [];
      const rowTextByItem = {};
      for (const itemId of ids) {
        const row = [...document.querySelectorAll('[data-testid="dc-dataset-item"]')]
          .find((r) => r.querySelector(`[data-testid="dc-caption-${itemId}"]`));
        rowTextByItem[itemId] = (row?.textContent ?? '').trim().replace(/\s+/g, ' ');
      }
      for (const itemId of ids) {
        H.check(`scratch item ${itemId} is in the Train snapshot review`, Boolean(rowTextByItem[itemId]));
        H.check(`scratch item ${itemId} is included in the snapshot`, /in · weight/i.test(rowTextByItem[itemId] ?? ''));
      }
      H.note(`Train snapshot evidence: ${ids.map((id) => `${id}: "${rowTextByItem[id] ?? ''}" · contributor as shown: "${ctx.contributorByItem?.[id] ?? ''}" · blob ref ${ctx.blobRefs?.[id] ?? ''}`).join(' | ') || 'none'}`);
      if (q('dc-train-disabled-reason') || q('dc-skipped')) {
        const reason = (textOf('dc-train-disabled-reason') || textOf('dc-skipped')).trim().replace(/\s+/g, ' ').slice(0, 240);
        H.armed.odTrainLimited = `live training cannot run for this scratch dataset: the app reports “${reason}”. A scratch item becomes trainable only as a Civitai blob uploaded through the host; the runner will not upload a file for the user, and it will not train from a real user dataset instead.`;
        H.liveLimit(H.armed.odTrainLimited);
        return;
      }
      await clickTestId('dc-estimate', 10_000);
      // A consent request is a park, not yet a wall: the host may
      // grant it (the mock does; a live user can), and the app then
      // re-prices on its own. Only a wall still standing after a
      // grace period is recorded verbatim as the wall.
      let consentSince = null;
      const outcome = await waitPoll(() => {
        if (q('dc-confirm')) return { card: true };
        if (q('dc-unquoted')) return { unquoted: textOf('dc-unquoted') };
        if (q('dc-consent')) {
          if (consentSince == null) consentSince = Date.now();
          if (Date.now() - consentSince > 8_000) return { consent: odConsentText() };
          return null;
        }
        consentSince = null;
        return null;
      }, 30_000).catch(() => null);
      if (outcome?.consent) throw new ConsentWallError(outcome.consent);
      if (outcome?.unquoted) {
        H.note(`branch: dc-unquoted (no usable quote) · detail, verbatim: "${(outcome.unquoted ?? '').trim().replace(/\s+/g, ' ')}"`);
        H.armed.odTrainLimited = `the app did not obtain a usable training quote (verbatim: “${(outcome.unquoted ?? '').trim().replace(/\s+/g, ' ')}”) — it refuses to submit unquoted, and so does the runner.`;
        H.liveLimit(H.armed.odTrainLimited);
        return;
      }
      if (q('dc-insufficient')) {
        H.note(`branch: dc-insufficient · detail, verbatim: "${textOf('dc-insufficient').trim().replace(/\s+/g, ' ')}"`);
        H.armed.odTrainLimited = `insufficient-Buzz wall at the Train price card (verbatim: “${textOf('dc-insufficient').trim().replace(/\s+/g, ' ')}”) — the run cannot proceed past it and no spend was attempted.`;
        H.liveLimit(H.armed.odTrainLimited);
        return;
      }
      H.check('training price-confirm card appears', Boolean(outcome?.card));
      H.check('confirm card names the Buzz price', textOf('dc-quote').includes('Buzz'));
      H.note(`branch: dc-confirm (quoted) · quoted cost, verbatim: "${textOf('dc-quote').trim().replace(/\s+/g, ' ')}" · ${H.auto ? 'Auto mode will confirm it if priced at/under the cap.' : 'Auto OFF: card reached, awaiting-user halt — nothing was submitted and no Buzz was spent.'}`);
    },

    odTrainOutcome: async (H) => {
      // Dependency honesty: a priced prerequisite that never happened
      // (quote-less, wall, disabled) ends this step LIVE-LIMITED with
      // the confirm step's reason — never FAIL on an empty run state
      // (live runs walk-2026-10-08-1329/-1419 graded FAIL on
      // dc-run-state "" after a "No price quote" confirm).
      if (H.armed.odTrainLimited) {
        H.liveLimit(`dependency: the Train price-confirm step did not produce a priced run earlier in this run — ${H.armed.odTrainLimited}`);
        return;
      }
      const terminal = await waitPoll(() => {
        if (q('dc-consent')) return { consent: odConsentText() };
        if (q('dc-run-failed')) return { failed: true };
        return q('dc-run') ? { run: true } : null;
      }, 120_000).catch(() => null);
      if (terminal?.consent) throw new ConsentWallError(terminal.consent);
      H.check('a training run state is reached after the confirm', Boolean(terminal?.run));
      // Let the run settle toward a linkable state before reading it:
      // the LoRA record is persisted from the same poll that surfaces
      // epochs/publish linkage, and the next steps look for it.
      await waitPoll(
        () => q('dc-published') || q('dc-moderation') || q('dc-run-failed') || q('dc-publish'),
        30_000,
      ).catch(() => {});
      if (terminal?.failed || q('dc-run-failed')) {
        H.check('training run did not end in failure', false);
        H.note(`run failed, app verbatim: “${textOf('dc-run-failed').trim().replace(/\s+/g, ' ').slice(0, 240)}”`);
        return;
      }
      H.check('training run did not end in failure', true);
      H.note(`run state, verbatim: “${textOf('dc-run-state').trim().replace(/\s+/g, ' ').slice(0, 160)}” · cost so far: “${textOf('dc-run-cost').trim().replace(/\s+/g, ' ').slice(0, 120)}”`);
      if (q('dc-published')) {
        H.note(`published state, verbatim: “${textOf('dc-published').trim().replace(/\s+/g, ' ').slice(0, 200)}”`);
      } else if (q('dc-moderation')) {
        H.note('the run is awaiting moderation (no trained epochs yet) — an honest live state; Publish stays the owner’s external wizard action and is never clicked by the runner.');
      } else {
        H.note('the run is in flight or ready-to-publish — an honest live state; the runner never clicks Publish.');
      }
    },

    odLoraDetail: async (H) => {
      if (!q('dc-lora')) {
        if (q('dc-train')) await clickTestId('dc-back-dataset', 10_000).catch(() => {});
        const tryOpen = async () => {
          const btn = document.querySelector('[data-testid^="dc-open-lora-"]');
          if (!btn) return false;
          btn.scrollIntoView?.({ block: 'center' });
          btn.click();
          return Boolean(await waitPoll(() => q('dc-lora'), 10_000).catch(() => null));
        };
        let opened = false;
        if (q('dc-dataset-detail')) {
          // The LoRA record lands from the training poll; give it a
          // moment to fold into the dataset detail first.
          await waitPoll(() => q('dc-dataset-loras'), 15_000).catch(() => {});
          if (q('dc-dataset-loras')) opened = await tryOpen();
        }
        if (!opened && H.scratch?.name) {
          await odGoExplore();
          const found = await odOpenDatasetByName(H.scratch.name).catch(() => null);
          if (found) {
            await waitPoll(() => q('dc-dataset-loras'), 8_000).catch(() => {});
            if (q('dc-dataset-loras')) opened = await tryOpen();
          }
        }
        if (!opened) {
          // Read-only scan of whatever Explore offers.
          await odGoExplore();
          for (const card of odDatasetCards().slice(0, 6)) {
            if (!(await odOpenCard(card))) continue;
            await waitPoll(() => q('dc-dataset-loras'), 5_000).catch(() => {});
            if (q('dc-dataset-loras')) { opened = await tryOpen(); if (opened) break; }
            await odGoExplore();
          }
        }
        if (!opened) {
          const reason = 'no LoRA record is reachable from the scratch dataset or the first Explore datasets on this account — LoRA detail cannot be manufactured without completing (and publishing) a training run, which is a priced, owner-gated flow.';
          H.armed.odLoraLimited = reason;
          H.liveLimit(reason);
          return;
        }
      }
      H.check('LoRA detail renders', Boolean(q('dc-lora')));
      H.check('LoRA shows its frozen snapshot or an honest unlinked state', Boolean(q('dc-lora-snapshot') || q('dc-lora-unlinked')));
      H.check('LoRA tracked-events block renders', Boolean(q('dc-lora-events')));
      H.note(`LoRA detail head, verbatim: “${textOf('dc-lora').trim().replace(/\s+/g, ' ').slice(0, 160)}” — account state, noted not asserted.`);
    },

    odLoraTestConfirm: async (H) => {
      if (!q('dc-lora')) {
        H.liveLimit(`dependency: LoRA detail was not reached earlier in this run — ${H.armed.odLoraLimited ?? 'no LoRA record was reachable.'}`);
        return;
      }
      if (q('dc-lora-unlinked') || !q('dc-lora-estimate')) {
        H.armed.odLoraTestLimited = 'this LoRA is not linked to a published Civitai model version, so no test generation can be priced; finishing the publish wizard is an external, owner-driven action the runner never performs.';
        H.liveLimit(H.armed.odLoraTestLimited);
        return;
      }
      await typeInto('dc-lora-prompt', 'toil-killer test portrait, front view');
      await clickTestId('dc-lora-estimate', 10_000);
      const outcome = await waitPoll(() => {
        if (q('dc-lora-confirm')) return { card: true };
        if (q('dc-lora-error')) return { error: textOf('dc-lora-error') };
        return null;
      }, 30_000).catch(() => null);
      if (q('dc-lora-insufficient')) {
        H.armed.odLoraTestLimited = `insufficient-Buzz wall at the test-generation price card (verbatim: “${textOf('dc-lora-insufficient').trim().replace(/\s+/g, ' ').slice(0, 240)}”) — no spend was attempted.`;
        H.liveLimit(H.armed.odLoraTestLimited);
        return;
      }
      if (outcome?.error && !outcome?.card) {
        H.armed.odLoraTestLimited = `test-generation pricing failed in the app (verbatim: “${(outcome.error ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)}”) — the state is reported, not retried into a spend.`;
        H.liveLimit(H.armed.odLoraTestLimited);
        return;
      }
      H.check('test-generation price-confirm card appears', Boolean(outcome?.card));
      H.check('confirm card names the Buzz price', textOf('dc-lora-quote').includes('Buzz'));
      H.note(H.auto ? 'card reached; Auto mode will confirm it if priced at/under the cap.' : 'card reached; the runner will not click it (§5).');
    },

    odLoraTestOutcome: async (H) => {
      if (!q('dc-lora')) {
        H.liveLimit(`dependency: no LoRA test generation was priced earlier in this run — ${H.armed.odLoraLimited ?? 'LoRA detail was not reached.'}`);
        return;
      }
      // Same dependency honesty as odTrainOutcome: a confirm step
      // that ended live-limited (unlinked, wall, pricing error) means
      // no generation was ever priced — LIVE-LIMITED, never FAIL.
      if (H.armed.odLoraTestLimited) {
        H.liveLimit(`dependency: the LoRA test-generation price-confirm step did not produce a priced generation earlier in this run — ${H.armed.odLoraTestLimited}`);
        return;
      }
      const terminal = await waitPoll(() => {
        if (q('dc-lora-image')) return { img: true };
        if (q('dc-lora-error')) return { error: textOf('dc-lora-error') };
        return null;
      }, 90_000).catch(() => null);
      H.check('test generation lands an image after the confirm', Boolean(terminal?.img));
      if (terminal?.error) {
        H.note(`generation error, verbatim: “${(terminal.error ?? '').trim().replace(/\s+/g, ' ').slice(0, 240)}”`);
      }
    },

    odLedger: async (H) => {
      await odGoExplore();
      await clickTestId('dc-open-ledger', 10_000);
      const landed = await waitPoll(() => (q('dc-ledger-view') || q('dc-ledger-guest') ? true : null), 12_000).catch(() => null);
      H.check('ledger view renders', Boolean(landed));
      if (q('dc-ledger-guest')) {
        H.check('guest wall renders with a sign-in action', Boolean(q('dc-ledger-signin')));
        H.note(`guest wall, verbatim: “${textOf('dc-ledger-guest').trim().replace(/\s+/g, ' ').slice(0, 200)}”`);
        return;
      }
      H.check('tracked-credit total renders', Boolean(q('dc-ledger-total')));
      H.check(
        'my-items / my-votes / my-snapshots / ledger rows / honest empty state renders',
        Boolean(q('dc-my-items') || q('dc-my-votes') || q('dc-my-snapshots') || q('dc-my-ledger-rows') || q('dc-ledger-empty') || q('dc-ledger-no-events')),
      );
      H.note(`tracked credit, verbatim: “${textOf('dc-ledger-total').trim().replace(/\s+/g, ' ').slice(0, 160)}” — account state, noted not asserted.`);
      await odGoExplore();
    },

    odWallGuest: async (H) => {
      if (H.live) {
        H.liveLimit('the guest wall cannot be shown on this signed-in session without signing the user out — detected-if-present only. The mock walk owns this state.');
        return;
      }
      await odGoExplore();
      await clickTestId('dc-open-ledger', 10_000);
      await waitPoll(() => q('dc-ledger-guest') || q('dc-ledger-view'), 12_000).catch(() => {});
      H.check('guest wall renders on the anonymous visit', Boolean(q('dc-ledger-guest')));
      H.check('guest wall offers sign-in', Boolean(q('dc-ledger-signin')));
      H.note(`guest wall, verbatim: “${textOf('dc-ledger-guest').trim().replace(/\s+/g, ' ').slice(0, 200)}”`);
    },

    odWallInsufficient: async (H) => {
      if (H.live) {
        H.liveLimit('an insufficient-Buzz wall cannot be manufactured without draining the user’s account — never. Detected-if-present only; the mock walk owns this state.');
        return;
      }
      await odGoExplore();
      const card = odDatasetCards()[0];
      if (!card) throw new Error('no demo dataset card to train from on the mock harness');
      await odOpenCard(card);
      await clickTestId('dc-open-train', 10_000);
      await waitPoll(() => q('dc-train'), 12_000);
      await clickTestId('dc-estimate', 10_000);
      const outcome = await waitPoll(() => {
        if (q('dc-insufficient')) return { insufficient: true };
        if (q('dc-unquoted')) return { unquoted: textOf('dc-unquoted') };
        if (q('dc-consent')) return { consent: odConsentText() };
        return null;
      }, 30_000).catch(() => null);
      if (outcome?.consent) throw new ConsentWallError(outcome.consent);
      H.check('insufficient-Buzz wall replaces the submit action', Boolean(outcome?.insufficient));
      H.note(`insufficient wall, verbatim: “${textOf('dc-insufficient').trim().replace(/\s+/g, ' ')}”`);
    },

    odWallConsent: async (H) => {
      const wall = odConsentText();
      if (wall) throw new ConsentWallError(wall);
      if (H.live) {
        H.liveLimit('no consent wall is present on this consenting account, and one cannot be forced from inside the app — detected-if-present only. The mock walk owns this state.');
        return;
      }
      // On the ungrantable harness the storage read can still fold
      // the demo seed, so the wall surfaces where consent is actually
      // requested: the Train estimate. Drive there (read-only until
      // the estimate click) and let the app raise its wall.
      const card = await waitPoll(() => odDatasetCards()[0] ?? null, 10_000).catch(() => null);
      if (!card) throw new Error('no demo dataset card to train from on the mock harness');
      await odOpenCard(card);
      await clickTestId('dc-open-train', 10_000);
      await waitPoll(() => q('dc-train'), 12_000);
      await clickTestId('dc-estimate', 10_000);
      const raised = await waitPoll(() => {
        const text = odConsentText();
        return text ? { wall: text } : null;
      }, 20_000).catch(() => null);
      if (raised?.wall) throw new ConsentWallError(raised.wall);
      H.check('consent wall renders verbatim on the ungrantable-consent harness', false);
      H.note('dc-community-unavailable / dc-consent did not appear on the consent=ungrantable visit — harness drift, reported not faked.');
    },
  };

  const OD_HANDLER_NAMES = [
    'odExplore', 'odDatasetDetail', 'odScratchCreate', 'odScratchEditContribute',
    'odTrainConfirm', 'odTrainOutcome', 'odLoraDetail', 'odLoraTestConfirm',
    'odLoraTestOutcome', 'odLedger', 'odWallGuest', 'odWallInsufficient', 'odWallConsent',
  ];

  /**
   * Run-end cleanup for Open Datasets: delete this run's scratch
   * dataset through the app's owner Delete action, then verify it no
   * longer lists in Explore. The toil-scratch- containment guard is
   * structural: any other name is refused untouched.
   */
  async function cleanupOpenDatasetsScratch(ctx) {
    const result = { deleted: [], alreadyAbsent: [], failed: [] };
    const name = ctx?.name;
    if (!name) return result;
    if (!name.startsWith('toil-scratch-')) {
      result.failed.push({
        id: ctx.id ?? name, name,
        error: 'GUARD (§5 containment): the recorded scratch dataset name does not carry the toil-scratch- marker — cleanup refused to touch it.',
      });
      return result;
    }
    try {
      await odGoExplore();
      const card = await odFindCardByName(name);
      if (!card) {
        result.alreadyAbsent.push(name);
        return result;
      }
      await odOpenCard(card);
      if (!q('dc-delete-dataset')) {
        result.failed.push({
          id: ctx.id ?? name, name,
          error: 'the app in this tab has no owner “Delete dataset” action (dc-delete-dataset) — the Open Datasets build with dataset deletion must be published before live cleanup can pass. Delete the scratch dataset by hand.',
        });
        return result;
      }
      await clickTestId('dc-delete-dataset', 10_000);
      await odGoExplore();
      const stillThere = await odFindCardByName(name);
      if (stillThere) {
        result.failed.push({
          id: ctx.id ?? name, name,
          error: 'clicked Delete dataset but the scratch dataset still lists in Explore — delete it by hand.',
        });
      } else {
        result.deleted.push(name);
      }
    } catch (err) {
      result.failed.push({ id: ctx.id ?? name, name, error: String(err?.message ?? err).slice(0, 300) });
    }
    return result;
  }

  // Auto-confirm (v0.4.0): the ONLY place eb-confirm-run is clicked,
  // and only under the panel's Auto opt-in with a price at/under the
  // run's cap. The §5 rail in clickTestId stays absolute — this path
  // does not go through it, it verifies the stated price itself:
  // card text must name a Buzz price, the first such price is the
  // charge, and cap 0 / unpriced / over-cap all refuse (the panel
  // then falls back to the manual gate). Consent walls refuse too.
  function autoConfirm(capBuzz, appId) {
    // Per-binding card shapes: the confirm card, its Buzz quote, its
    // submit action, and its insufficient-Buzz wall. The submit is
    // clicked directly here — the sole Auto spend path — only after
    // the card's own stated price verifies at/under the cap.
    const shapes = appId === 'open-datasets'
      ? [
          { card: 'dc-confirm', quote: 'dc-quote', submit: 'dc-confirm-submit', insufficient: 'dc-insufficient', wall: odConsentText },
          { card: 'dc-lora-confirm', quote: 'dc-lora-quote', submit: 'dc-lora-confirm-submit', insufficient: 'dc-lora-insufficient', wall: odConsentText },
        ]
      : [
          { card: 'eb-confirm', quote: null, submit: 'eb-confirm-run', insufficient: null, wall: consentWallText },
        ];
    for (const shape of shapes) {
      const card = q(shape.card);
      if (!card) continue;
      const wall = shape.wall();
      if (wall) return { clicked: false, reason: 'consent wall present — never auto-confirmed' };
      if (shape.insufficient && q(shape.insufficient)) {
        return { clicked: false, reason: 'insufficient-Buzz wall present — never auto-confirmed' };
      }
      const text = (shape.quote ? textOf(shape.quote) : (card.textContent ?? '')).replace(/\s+/g, ' ');
      const m = text.match(/([\d,]+(?:\.\d+)?)\s*Buzz/i);
      if (!m) return { clicked: false, reason: `card names no Buzz price (verbatim: “${text.slice(0, 120)}”)` };
      const price = Number.parseFloat(m[1].replace(/,/g, ''));
      if (!(price <= capBuzz)) {
        return { clicked: false, reason: `price ${price} Buzz exceeds the Auto cap ${capBuzz} Buzz` };
      }
      const btn = q(shape.submit);
      if (!btn) return { clicked: false, reason: 'card is open but its Confirm action is missing' };
      btn.scrollIntoView?.({ block: 'center' });
      btn.click();
      return { clicked: true, price };
    }
    return { clicked: false, reason: 'no price-confirm card is open' };
  }

  /** Execute one catalog step in this frame; return its record. */
  async function runWalkStep(msg) {
    const def = msg.step;
    // Binding resolution: the step def may pin its app; else the
    // panel's picked app; Email Builder is the historical default.
    const appId = def.app ?? msg.appId ?? 'email-builder';
    const isOD = appId === 'open-datasets';
    const handlers = isOD ? OD_HANDLERS : IN_PAGE_HANDLERS;
    const rootTestid = isOD ? 'dc-community' : 'eb-app';
    const wallTextOf = isOD ? odConsentText : consentWallText;
    const record = {
      id: def.id,
      name: def.name,
      group: def.group,
      file: def.file,
      liveClass: def.liveClass,
      status: 'pass',
      checks: [],
      notes: [],
      errors: [],
      confirmLeftOpen: false,
      viewport: null,
      wall: null, // 'consent' when a consent wall ended the step (§8.6)
      wallText: null, // the wall state, verbatim
      executorVersion: EXECUTOR_VERSION, // build stamp (v0.2.2 handshake)
      scratch: null, // this run's scratch record, once created
    };
    walkCtl.runId = msg.runId ?? null;
    walkCtl.stopped = false;
    walkCtl.paused = false;
    walkCtl.awaiting = null;

    // Honesty gates fire before anything touches the page (§6).
    if (def.liveClass === 'skip-live') {
      record.status = 'skipped';
      record.notes.push(`skip-live: ${SKIP_LIVE_REASONS[def.id] ?? 'not runnable on live (spec §6)'} — not run.`);
      return record;
    }
    if (def.liveClass === 'scratch-only' && msg.allowScratch === false) {
      // §8.7 toggle OFF: the whole run stays read-only.
      record.status = 'skipped';
      record.notes.push(
        `scratch-only: the “allow scratch ${isOD ? 'datasets' : 'drafts'}” toggle is OFF, so this run is read-only — stateful steps are not run (§5/§8.7).`,
      );
      return record;
    }
    if (def.liveClass === 'live-limited' && !handlers[def.handler]) {
      // Handler-less limited step: report, never improvise. (The
      // broken-banner trio has handlers now — they detect for real.)
      record.status = 'live-limited';
      record.notes.push(`live-limited: ${LIVE_LIMITED_REASON} — not run.`);
      return record;
    }

    if (!q(rootTestid)) {
      // Don't fail instantly: app frames boot asynchronously (host
      // handshake), and a just-navigated page's old document can answer
      // the frame probe a beat before the new one exists. Wait for
      // the app like run.mjs's visit() does; fail only after that.
      let booted = null;
      try {
        booted = await waitPoll(() => q(rootTestid), 15_000);
      } catch (err) {
        if (err?.tkStop) {
          record.status = 'skipped';
          record.notes.push('stopped by you while the app was loading.');
          return record;
        }
        throw err;
      }
      if (!booted) {
        record.status = 'fail';
        record.errors.push(`${rootTestid} not present in the target frame after 15s — wrong frame, or the app did not load.`);
        return record;
      }
    }

    const errsBefore = pageErrors.length;
    walkCtl.active = true;
    let handlerSettled = false;
    const H = makeH(record, msg);
    try {
      await Promise.race([
        (async () => {
          try {
            await sleep(400); // settle after eb-app appears (mirrors run.mjs)
            if (def.executor === 'data') {
              if (H.live) await runLiveFirstRun(H);
              else await runDataChecks(record, def, H);
            } else {
              const handler = handlers[def.handler];
              if (!handler) {
                record.status = 'skipped';
                record.notes.push(
                  `in-page handler "${def.handler}" is not implemented in this build — not run, never improvised.`,
                );
                return;
              }
              await handler(H, def);
            }
          } finally {
            handlerSettled = true;
          }
        })(),
        watchStepExecution(
          () => handlerSettled,
          WORKING_WATCHDOG_HANDLERS.has(def.handler) ? WORKING_WATCHDOG_MS : STEP_WATCHDOG_MS,
        ),
      ]);
    } catch (err) {
      if (err?.tkWall === 'consent') {
        // §5: the wall is recorded verbatim, never clicked through;
        // the step ends live-limited and the panel stops the run.
        record.status = 'live-limited';
        record.wall = 'consent';
        record.wallText = err.wallText;
        record.notes.push(`consent wall recorded verbatim: “${err.wallText}”`);
      } else if (err?.tkStop) {
        record.status = 'skipped';
        record.notes.push('stopped by you mid-step.');
      } else {
        record.status = 'fail';
        record.errors.push(`step error: ${String(err?.message ?? err).slice(0, 300)}`);
      }
    } finally {
      walkCtl.active = false;
      walkCtl.awaiting = null;
    }
    record.scratch = H.scratch ?? null;
    record.armed = H.armed ?? {};

    // Ambient wall detection: a consent wall the handler did not trip
    // over directly still ends the step truthfully (detected-if-present).
    if (record.status !== 'live-limited' && record.status !== 'skipped') {
      const wallText = wallTextOf();
      if (wallText) {
        record.status = 'live-limited';
        record.wall = 'consent';
        record.wallText = wallText;
        record.notes.push(`consent wall recorded verbatim: “${wallText}”`);
      }
    }

    // Page/console errors seen during the step fail it, verbatim (§5).
    const newErrors = pageErrors.slice(errsBefore);
    if (newErrors.length) {
      record.errors.push(...newErrors);
      if (record.status === 'pass') record.status = 'fail';
    }
    const surprise = surpriseDialogText();
    if (surprise) {
      record.errors.push(`unexpected modal (recorded verbatim, not clicked): “${surprise}”`);
      if (record.status === 'pass') record.status = 'fail';
    }

    record.confirmLeftOpen = isOD
      ? Boolean((q('dc-confirm') && q('dc-confirm-submit')) || (q('dc-lora-confirm') && q('dc-lora-confirm-submit')))
      : Boolean(q('eb-confirm'));
    record.viewport = `${window.innerWidth}×${window.innerHeight} (step asks ${def.viewport}; the tab cannot be resized — §6)`;
    return record;
  }

  // Announce this frame to the hub (for the embedded-view stretch probe,
  // every frame reports in, so the panel can see which frames exist).
  // App frames boot asynchronously (host handshake), so announce again
  // until the app actually appears — the panel's "eb-app seen" label
  // must tell the truth, not the boot-time guess.
  function announce() {
    try {
      const ebFound = q('eb-app') !== null;
      const dcFound = q('dc-community') !== null;
      chrome.runtime.sendMessage({
        type: 'tk-frame-hello',
        executorVersion: EXECUTOR_VERSION,
        url: location.href,
        isTop,
        ebAppFound: ebFound,
        dcAppFound: dcFound,
        appFound: ebFound || dcFound,
        appId: dcFound ? 'open-datasets' : ebFound ? 'email-builder' : null,
        appRootTestid: dcFound ? 'dc-community' : ebFound ? 'eb-app' : null,
      }).catch(() => {});
    } catch { /* extension context may not exist under test harnesses */ }
  }
  announce();
  if (!q('eb-app') && !q('dc-community')) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (q('eb-app') || q('dc-community') || tries >= 20) {
        clearInterval(timer);
        announce();
      }
    }, 1_000);
  }
  // The hub's registry lives in the MV3 service worker's memory and
  // dies with it on a routine restart; the hub probes on demand to
  // heal that (v0.7.2), and these re-announcements cover the same
  // gap whenever the tab comes back into view — cheap, and they
  // keep the panel's live sightings fed between probes.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') announce();
  });
  window.addEventListener('focus', announce);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'tk-probe-run') {
      runProbe(msg.action)
        .then(sendResponse)
        .catch((err) => sendResponse({ action: msg.action, note: `probe threw: ${err?.message ?? err}` }));
      return true; // keep the message channel open for the async response
    }
    if (msg?.type === 'tk-walk-cleanup') {
      // Run-end scratch cleanup (§8.6): delete every draft in the
      // scratch record the panel hands back. Each delete re-verifies
      // id+name against that record — a real draft cannot be deleted
      // through here even if the record were wrong.
      if (walkCtl.active) {
        sendResponse({
          deleted: [], alreadyAbsent: [],
          failed: [{
            id: msg.scratch?.id ?? '?', name: msg.scratch?.name ?? '?',
            error: 'a step is still running in this frame; cleanup refused rather than race it — remove the scratch draft by hand.',
          }],
        });
        return false;
      }
      const cleanup = msg.appId === 'open-datasets' || msg.scratch?.appId === 'open-datasets'
        ? cleanupOpenDatasetsScratch(msg.scratch)
        : cleanupScratch(msg.scratch);
      cleanup
        .then(sendResponse)
        .catch((err) => sendResponse({
          deleted: [], alreadyAbsent: [],
          failed: [{
            id: msg.scratch?.id ?? '?', name: msg.scratch?.name ?? '?',
            error: String(err?.message ?? err).slice(0, 300),
          }],
        }));
      return true;
    }
    if (msg?.type === 'tk-walk-auto-confirm') {
      // Panel Auto gate (v0.4.0): clicks the open price card only
      // at/under the run's cap; the verdict returns verbatim.
      if (msg.runId != null && walkCtl.runId != null && msg.runId !== walkCtl.runId) {
        sendResponse({ clicked: false, reason: 'run id mismatch — auto-confirm refused' });
        return false;
      }
      // Let the card settle before clicking: a card that just
      // rendered may not have its workflow finalized yet, and an
      // instant click can submit against a half-wired card (the
      // user-paced path never hits this — the user's own click
      // comes seconds later). The price is re-read after the wait.
      (async () => {
        try {
          const cap = Number.isFinite(msg.capBuzz) && msg.capBuzz >= 0 ? msg.capBuzz : 0;
          const cardIds = msg.appId === 'open-datasets' ? ['dc-confirm', 'dc-lora-confirm'] : ['eb-confirm'];
          await waitPoll(() => cardIds.some((id) => q(id)), 5_000).catch(() => null);
          await sleep(1_200);
          sendResponse(autoConfirm(cap, msg.appId));
        } catch (err) {
          sendResponse({ clicked: false, reason: `auto-confirm threw: ${String(err?.message ?? err).slice(0, 200)}` });
        }
      })();
      return true;
    }
    if (msg?.type === 'tk-walk-step') {
      if (walkCtl.active) {
        sendResponse({ id: msg.step?.id, status: 'fail', executorVersion: EXECUTOR_VERSION, checks: [], notes: [], errors: ['executor busy — a step is already running in this frame; refusing to overlap runs.'] });
        return false;
      }
      runWalkStep(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({
          id: msg.step?.id, status: 'fail', executorVersion: EXECUTOR_VERSION, checks: [], notes: [],
          errors: [`executor error: ${String(err?.message ?? err).slice(0, 300)}`],
        }));
      return true;
    }
    if (msg?.type === 'tk-walk-control') {
      // Run control from the panel. runId must match the active run so
      // a stale panel can never steer a newer run.
      if (msg.runId != null && walkCtl.runId != null && msg.runId !== walkCtl.runId) return false;
      if (msg.action === 'pause') walkCtl.paused = true;
      else if (msg.action === 'resume') walkCtl.paused = false;
      else if (msg.action === 'stop') {
        walkCtl.stopped = true;
        walkCtl.paused = false;
        if (walkCtl.awaiting) { walkCtl.awaiting.resolve('end'); walkCtl.awaiting = null; }
      } else if (msg.action === 'user-decision') {
        if (walkCtl.awaiting) {
          walkCtl.awaiting.resolve(msg.decision === 'resume' ? 'resume' : 'end');
          walkCtl.awaiting = null;
        }
      }
      sendResponse({ ok: true });
      return false;
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

  // Dev hook for headless verification, localhost harness only. Inert
  // on every live origin. Drives the REAL watchdog accounting
  // (watchStepExecution) with a short fuse: the "handler" never
  // settles, and a §5-style user park (walkCtl.awaiting — the same
  // flag H.awaitUser sets) is held across the fuse, then released.
  // Proves parks don't burn execution budget while a genuinely
  // runaway step still fails. The JSON lands in a node with
  // id="tk-watchdog-result" for a test driver to read.
  if (location.hostname === 'localhost') {
    document.addEventListener('tk-watchdog-dev', async (event) => {
      const { budgetMs = 1500, parkMs = 2500 } = event.detail ?? {};
      const t0 = Date.now();
      const prior = {
        awaiting: walkCtl.awaiting, paused: walkCtl.paused, stopped: walkCtl.stopped,
      };
      let firedAtMs = null;
      let error = null;
      walkCtl.stopped = false;
      walkCtl.paused = false;
      walkCtl.awaiting = { resolve: () => {} }; // parked, as H.awaitUser leaves it
      const watch = watchStepExecution(() => false, budgetMs).catch((err) => {
        firedAtMs = Date.now() - t0;
        error = String(err?.message ?? err);
      });
      await sleep(parkMs);
      const firedDuringPark = firedAtMs !== null;
      walkCtl.awaiting = null; // the user acts; execution resumes
      const deadline = Date.now() + budgetMs + 4000;
      while (firedAtMs === null && Date.now() < deadline) await sleep(100);
      await Promise.race([watch, sleep(250)]);
      walkCtl.awaiting = prior.awaiting;
      walkCtl.paused = prior.paused;
      walkCtl.stopped = prior.stopped;
      let node = document.getElementById('tk-watchdog-result');
      if (!node) {
        node = document.createElement('pre');
        node.id = 'tk-watchdog-result';
        node.style.display = 'none';
        document.body.appendChild(node);
      }
      node.textContent = JSON.stringify({ budgetMs, parkMs, firedDuringPark, firedAtMs, error });
    });
  }
})();

