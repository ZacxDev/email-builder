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

  function presentTestids() {
    return KNOWN_TESTIDS.filter((id) => q(id) !== null);
  }

  function probeInject() {
    const evidence = {
      action: 'inject',
      executorVersion: EXECUTOR_VERSION,
      url: location.href,
      isTop,
      title: document.title,
      readyState: document.readyState,
      ebAppFound: q('eb-app') !== null,
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
  const SPEND_CONFIRM_TESTIDS = ['eb-confirm-run'];

  const CHECK_TIMEOUT_MS = 10_000;
  const STEP_WATCHDOG_MS = 150_000;

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
    const name = `${SCRATCH_PREFIX}${scratchStamp()}`;
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
      if (el.closest('[data-testid="eb-confirm"], [data-harness], [data-harness-banner]')) continue;
      if (el.querySelector('[data-testid="eb-confirm"]')) continue;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      if (text) return text;
    }
    return null;
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
    const terminal = await waitPoll(() => {
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
    }, 45_000);
    if (terminal?.wall) throw new ConsentWallError(terminal.wall);
    H.check(
      H.auto
        ? 'the typed turn is in the transcript (sent by the runner under Auto mode)'
        : 'the typed turn is in the transcript (sent by the user, never by the runner)',
      countSentTurns(turnText) > turnsBefore,
    );
    if (terminal?.reply) {
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
      H.note(`nothing terminal landed within 45s (turn sent, still no reply) — transcript tail, verbatim: “${tail || '(empty)'}”.`);
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
    await sleep(300);
    const after = document.querySelector('[aria-label="Subject"]')?.value ?? '';
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
      const terminal = await waitPoll(() => {
        const wall = consentWallText();
        if (wall) return { wall };
        return q('eb-draft-widget') ||
          q('eb-repair-offer') ||
          textOf('eb-notice').length > 0 ||
          transcriptHas('shape I couldn’t read')
          ? { done: true }
          : null;
      }, 60_000);
      if (terminal?.wall) throw new ConsentWallError(terminal.wall);
      H.check('confirm card is dismissed', !q('eb-confirm'));
      const notice = textOf('eb-notice');
      const widget = Boolean(q('eb-draft-widget'));
      H.check('an honest terminal state is reached', widget || notice.length > 0);
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
      await sleep(800);
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
      const got = await waitPoll(() => {
        const wall = consentWallText();
        if (wall) return { wall };
        return q('eb-banner-img') ? { img: true } : null;
      }, 60_000);
      if (got?.wall) throw new ConsentWallError(got.wall);
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

  // Auto-confirm (v0.4.0): the ONLY place eb-confirm-run is clicked,
  // and only under the panel's Auto opt-in with a price at/under the
  // run's cap. The §5 rail in clickTestId stays absolute — this path
  // does not go through it, it verifies the stated price itself:
  // card text must name a Buzz price, the first such price is the
  // charge, and cap 0 / unpriced / over-cap all refuse (the panel
  // then falls back to the manual gate). Consent walls refuse too.
  function autoConfirm(capBuzz) {
    const wall = consentWallText();
    if (wall) return { clicked: false, reason: 'consent wall present — never auto-confirmed' };
    const card = q('eb-confirm');
    if (!card) return { clicked: false, reason: 'no price-confirm card is open' };
    const text = (card.textContent ?? '').replace(/\s+/g, ' ');
    const m = text.match(/(\d+(?:\.\d+)?)\s*Buzz/i);
    if (!m) return { clicked: false, reason: `card names no Buzz price (verbatim: “${text.slice(0, 120)}”)` };
    const price = Number.parseFloat(m[1]);
    if (!(price <= capBuzz)) {
      return { clicked: false, reason: `price ${price} Buzz exceeds the Auto cap ${capBuzz} Buzz` };
    }
    const btn = q('eb-confirm-run');
    if (!btn) return { clicked: false, reason: 'card is open but its Confirm action is missing' };
    btn.scrollIntoView?.({ block: 'center' });
    btn.click();
    return { clicked: true, price };
  }

  /** Execute one catalog step in this frame; return its record. */
  async function runWalkStep(msg) {
    const def = msg.step;
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
        'scratch-only: the “allow scratch drafts” toggle is OFF, so this run is read-only — stateful steps are not run (§5/§8.7).',
      );
      return record;
    }
    if (def.liveClass === 'live-limited' && !IN_PAGE_HANDLERS[def.handler]) {
      // Handler-less limited step: report, never improvise. (The
      // broken-banner trio has handlers now — they detect for real.)
      record.status = 'live-limited';
      record.notes.push(`live-limited: ${LIVE_LIMITED_REASON} — not run.`);
      return record;
    }

    if (!q('eb-app')) {
      // Don't fail instantly: app frames boot asynchronously (host
      // handshake), and a just-navigated page's old document can answer
      // the frame probe a beat before the new one exists. Wait for
      // the app like run.mjs's visit() does; fail only after that.
      let booted = null;
      try {
        booted = await waitPoll(() => q('eb-app'), 15_000);
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
        record.errors.push('eb-app not present in the target frame after 15s — wrong frame, or the app did not load.');
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
              const handler = IN_PAGE_HANDLERS[def.handler];
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
        watchStepExecution(() => handlerSettled),
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
      const wallText = consentWallText();
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

    record.confirmLeftOpen = Boolean(q('eb-confirm'));
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
      chrome.runtime.sendMessage({
        type: 'tk-frame-hello',
        executorVersion: EXECUTOR_VERSION,
        url: location.href,
        isTop,
        ebAppFound: q('eb-app') !== null,
      }).catch(() => {});
    } catch { /* extension context may not exist under test harnesses */ }
  }
  announce();
  if (!q('eb-app')) {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (q('eb-app') || tries >= 20) {
        clearInterval(timer);
        announce();
      }
    }, 1_000);
  }

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
      cleanupScratch(msg.scratch)
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
      try {
        sendResponse(autoConfirm(Number.isFinite(msg.capBuzz) && msg.capBuzz >= 0 ? msg.capBuzz : 0));
      } catch (err) {
        sendResponse({ clicked: false, reason: `auto-confirm threw: ${String(err?.message ?? err).slice(0, 200)}` });
      }
      return false;
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

