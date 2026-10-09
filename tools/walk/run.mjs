// Email Builder — reusable headless "walk" for screenshot review.
//
//   npm run walk                    boot (or reuse) the mock-host harness,
//                                   drive the core flows, screenshot every
//                                   meaningful state, write report.md +
//                                   strip.html (+ taste-strip.html when a
//                                   baseline exists)
//   npm run walk -- --baseline      same, then save this run's screenshots
//                                   as the baseline in tools/walk/baseline/
//
// No real Buzz: the mock host is the only host. No network leaves localhost:
// any non-localhost request (e.g. the mock's canned placehold.co banner) is
// intercepted and answered with a local MOCK stand-in image.
//
// Exit code is 1 when any step fails (a "mock-limited" step is not a
// failure: it means the mock host cannot produce the real artifact — e.g.
// readable model text — and the step instead verifies the app's honest
// terminal state for that situation).

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedQuery } from './seed.mjs';

const require = createRequire('/home/hatch/workspace/.clickthrough/');
const puppeteer = require('puppeteer-core');

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOAL_DIR = path.resolve(APP_DIR, '..', '..');
const BASE = process.env.EB_WALK_BASE ?? 'http://localhost:5186';
const BASELINE_DIR = path.join(APP_DIR, 'tools', 'walk', 'baseline');
const CHROME =
  '/home/hatch/workspace/.clickthrough/chrome-headless-shell-linux64/chrome-headless-shell';

const args = process.argv.slice(2);
const isBaseline = args.includes('--baseline');
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
const OUT =
  outArg ?? path.join(GOAL_DIR, 'files', 'app-review', 'email-builder', `walk-${today}`);
fs.mkdirSync(OUT, { recursive: true });

const SEEDED_URL = `${BASE}/?${seedQuery()}`;
const DESKTOP = { width: 1440, height: 1900 };
const MOBILE = { width: 390, height: 1700 };

const HIDE_DEV_CHROME = `
  [data-harness-banner], [data-harness-scenario-panel],
  [data-harness="true"] > details { display: none !important; }
  html, body { background: #101113; }
`;

// ---------------------------------------------------------------------------
// harness server lifecycle (boot only when nothing is already serving)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

let serverProc = null;
async function ensureServer() {
  if (await serverUp()) {
    console.log(`reusing harness already on ${BASE}`);
    return false;
  }
  console.log('booting npm run dev:harness …');
  serverProc = spawn('npm', ['run', 'dev:harness'], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  serverProc.stdout.on('data', (d) => (log += d));
  serverProc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (await serverUp()) return true;
    if (serverProc.exitCode !== null) break;
    await sleep(500);
  }
  throw new Error(`dev:harness did not come up.\n${log.slice(-2000)}`);
}

function stopServer() {
  if (!serverProc) return;
  try {
    process.kill(-serverProc.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  serverProc = null;
}

// ---------------------------------------------------------------------------
// small page helpers
// ---------------------------------------------------------------------------

const sel = (testid) => `[data-testid="${testid}"]`;

async function textOf(page, testid) {
  return page.$eval(sel(testid), (el) => el.textContent ?? '').catch(() => '');
}

async function exists(page, testid) {
  return (await page.$(sel(testid))) !== null;
}

async function waitFor(page, fn, timeoutMs, ...fnArgs) {
  await page.waitForFunction(fn, { timeout: timeoutMs, polling: 250 }, ...fnArgs);
}

async function clickTestId(page, testid) {
  await page.waitForSelector(sel(testid), { visible: true, timeout: 15_000 });
  await page.click(sel(testid));
}

const inPage = {
  transcriptHas: (needle) =>
    (document.querySelector('[data-testid="eb-transcript"]')?.textContent ?? '').includes(needle),
  draftsHas: (needle) =>
    (document.querySelector('[data-testid="eb-drafts"]')?.textContent ?? '').includes(needle),
  noticeHas: (needle) =>
    (document.querySelector('[data-testid="eb-notice"]')?.textContent ?? '').includes(needle),
  previewHas: (needle) =>
    (document.querySelector('[data-testid="eb-preview"]')?.textContent ?? '').includes(needle),
  flashHas: (needle) =>
    (document.querySelector('[data-testid="eb-flash"]')?.textContent ?? '').includes(needle),
  currentDraftIs: (needle) =>
    (document.querySelector('[data-testid="eb-current-draft"]')?.textContent ?? '').includes(needle),
};

/** Show the saved-drafts rows when the card starts collapsed. */
async function ensureDraftsOpen(page) {
  const toggle = await page.$(sel('eb-drafts-toggle'));
  if (!toggle) return;
  const expanded = await toggle.evaluate((el) => el.getAttribute('aria-expanded'));
  if (expanded !== 'true') {
    await toggle.click();
    await sleep(400);
  }
}

/** Click the "Open" button on the saved-draft row showing `name`. */
async function openDraftByName(page, name) {
  await ensureDraftsOpen(page);
  const clicked = await page.evaluate((draftName) => {
    const card = document.querySelector('[data-testid="eb-drafts"]');
    if (!card) return false;
    for (const btn of card.querySelectorAll('button')) {
      if (btn.textContent.trim() !== 'Open') continue;
      // Walk up to the row: the smallest ancestor that names this draft and
      // holds exactly this one Open button.
      let el = btn;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const opens = [...el.querySelectorAll('button')].filter(
          (b) => b.textContent.trim() === 'Open',
        );
        if (opens.length === 1 && el.textContent.includes(draftName)) {
          if (!draftName.endsWith('copy') && el.textContent.indexOf(`${draftName} copy`) === 0) continue;
          btn.click();
          return true;
        }
      }
    }
    return false;
  }, name);
  if (!clicked) throw new Error(`could not find an Open button for draft “${name}”`);
  await waitFor(page, inPage.currentDraftIs, 10_000, name);
}

/** Open a draft's ⋯ actions row (it survives rename, so don't toggle blindly). */
async function ensureDraftMenuOpen(page, draftId) {
  if (await exists(page, `eb-draft-actions-${draftId}`)) return;
  await clickTestId(page, `eb-draft-menu-${draftId}`);
}

async function typeAndSend(page, message) {
  await page.click(sel('eb-chat-input'));
  await page.type(sel('eb-chat-input'), message);
  await sleep(200);
  await page.click(sel('eb-send'));
}

// ---------------------------------------------------------------------------
// step machinery — every step asserts, screenshots, and records a verdict.
// A throwing step fails alone; the walk continues.
// ---------------------------------------------------------------------------

const results = [];
let activeStep = null;

async function doStep(name, file, viewportLabel, page, fn) {
  const step = {
    n: results.length + 1,
    name,
    file,
    viewport: viewportLabel,
    status: 'pass',
    mockLimited: null,
    checks: [],
    errors: [],
    notes: [],
    check(label, ok) {
      this.checks.push({ label, ok: !!ok });
      if (!ok) this.status = 'fail';
    },
    note(text) {
      this.notes.push(text);
    },
    mockLimit(reason) {
      this.mockLimited = reason;
    },
  };
  results.push(step);
  activeStep = step;
  try {
    await fn(step);
  } catch (err) {
    step.status = 'fail';
    step.errors.push(`step error: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  try {
    const filePath = path.join(OUT, file);
    await page.screenshot({ path: filePath });
    const bytes = fs.statSync(filePath).size;
    step.note(`screenshot ${file} (${Math.round(bytes / 1024)} KB)`);
    if (bytes === 0) step.check('screenshot file is non-empty', false);
  } catch (err) {
    step.status = 'fail';
    step.errors.push(`screenshot failed: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  return step;
}

const MOCK_IMG_SVG = Buffer.from(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1024' height='576'>` +
    `<rect width='1024' height='576' fill='#1971c2'/>` +
    `<text x='512' y='270' font-family='Arial' font-size='72' font-weight='700' fill='white' text-anchor='middle'>MOCK</text>` +
    `<text x='512' y='330' font-family='Arial' font-size='30' fill='#dbeafe' text-anchor='middle'>mock host banner (served locally)</text></svg>`,
);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// step catalog (tools/walk/steps.json) — the single source of truth shared
// with the toil-killer extension executor (spec §4.1). Order, names, files,
// viewports, visits, groups, and honesty metadata (mockLimited / liveClass /
// spends) come from the catalog; step bodies dispatch by step id. Any drift
// between the catalog and the handlers below fails loudly before the walk
// starts — there is no silent fallback.
// ---------------------------------------------------------------------------

const catalog = JSON.parse(
  fs.readFileSync(path.join(APP_DIR, 'tools', 'walk', 'steps.json'), 'utf8'),
);

/** Execute the data-expressible checks of an executor:"data" step. */
async function runDataChecks(s, page, def) {
  for (const c of def.checks) {
    if (c.kind === 'exists') {
      s.check(c.label, await exists(page, c.testid));
    } else if (c.kind === 'absent') {
      s.check(c.label, !(await exists(page, c.testid)));
    } else if (c.kind === 'textContains') {
      s.check(c.label, (await textOf(page, c.testid)).includes(c.text));
    } else {
      s.check(`known check kind (${c.kind})`, false);
    }
  }
}

/**
 * Imperative step bodies, keyed by the catalog's `handler` name. These are
 * the pre-catalog step bodies verbatim (mockLimit calls removed — the
 * catalog owns honesty metadata now); assertion logic is unchanged.
 */
const HANDLERS = {
  seededLibrary: async (s, page) => {
    await ensureDraftsOpen(page);
    const library = await textOf(page, 'eb-drafts');
    for (const name of [
      'Spring sale announcement',
      'Webinar invite',
      'Spring launch announcement', // the screenshot rig's own demo draft
      'October newsletter',
      'Dark mode launch',
      'Product tips digest',
    ]) {
      s.check(`library lists “${name}”`, library.includes(name));
    }
  },

  interviewDraftOpened: async (s, page) => {
    await openDraftByName(page, 'Dark mode launch');
    s.check(
      'header names the opened draft',
      (await textOf(page, 'eb-current-draft')).includes('Dark mode launch'),
    );
    s.check('brief is still “in progress”', (await textOf(page, 'eb-brief')).includes('in progress'));
    s.check('no preview card before a package exists', !(await exists(page, 'eb-preview')));
    s.check(
      'transcript shows the seeded interview turns',
      (await textOf(page, 'eb-transcript')).includes('Beta users first'),
    );
  },

  interviewChatTurn: async (s, page) => {
    await typeAndSend(page, 'One more thing: keep it under five sentences');
    // Terminal = an honest outcome note lands in the transcript (the
    // mock's empty snapshot lands on “didn’t reply”; an unreadable one
    // would land on the repair offer instead). A non-empty notice is NOT a
    // valid signal: the needs-consent notice is up while the turn is
    // still parked/working.
    await waitFor(
      page,
      () =>
        document.querySelector('[data-testid="eb-repair-offer"]') !== null ||
        (document.querySelector('[data-testid="eb-transcript"]')?.textContent ?? '').includes(
          'try sending again',
        ),
      45_000,
    ).catch(() => {});
    const transcript = await textOf(page, 'eb-transcript');
    s.check(
      'transcript records the honest no-reply note',
      transcript.includes('didn’t reply') || transcript.includes('shape I couldn’t read'),
    );
    s.note(
      transcript.includes('didn’t reply')
        ? 'mock snapshot carried no text; the app charged-note path rendered in-transcript'
        : 'unreadable-reply path rendered',
    );
  },

  briefReady: async (s, page) => {
    await openDraftByName(page, 'October newsletter');
    s.check('brief badge reads “ready”', (await textOf(page, 'eb-brief')).includes('ready'));
    s.check(
      'chat raises the “generate my email package” next step',
      await exists(page, 'eb-next-generate'),
    );
    s.check('no preview card before the package exists', !(await exists(page, 'eb-preview')));
    const genDisabled = await page
      .$eval(sel('eb-generate-bundle'), (el) => el.disabled)
      .catch(() => true);
    s.check('“Generate email package” is enabled', !genDisabled);
  },

  bundleConfirm: async (s, page) => {
    await clickTestId(page, 'eb-generate-bundle');
    await page.waitForSelector(sel('eb-confirm'), { visible: true, timeout: 30_000 }).catch(() => {});
    s.check('price-confirm card appears', await exists(page, 'eb-confirm'));
    s.check('confirm card names the Buzz price', (await textOf(page, 'eb-confirm')).includes('Buzz'));
    s.note('Consent was auto-granted by the mock host on the way to this card.');
  },

  bundleOutcome: async (s, page) => {
    await clickTestId(page, 'eb-confirm-run');
    await waitFor(
      page,
      () =>
        document.querySelector('[data-testid="eb-draft-widget"]') !== null ||
        document.querySelector('[data-testid="eb-repair-offer"]') !== null ||
        (document.querySelector('[data-testid="eb-notice"]')?.textContent ?? '').length > 0 ||
        (document.querySelector('[data-testid="eb-transcript"]')?.textContent ?? '').includes(
          'shape I couldn’t read',
        ),
      60_000,
    ).catch(() => {});
    s.check('confirm card is dismissed', !(await exists(page, 'eb-confirm')));
    const notice = await textOf(page, 'eb-notice');
    const widget = await exists(page, 'eb-draft-widget');
    s.check('an honest terminal state is reached', widget || notice.length > 0);
    s.note(widget ? 'a draft widget appeared' : `terminal notice: “${notice.trim()}”`);
  },

  finishedPreview: async (s, page) => {
    await openDraftByName(page, 'Spring sale announcement');
    await page.waitForSelector(sel('eb-banner-img'), { visible: true, timeout: 15_000 }).catch(() => {});
    const bannerOk = await page
      .$eval(sel('eb-banner-img'), (el) => el.complete && el.naturalWidth > 0)
      .catch(() => false);
    s.check('seeded banner image renders (local data-URI)', bannerOk);
    s.check(
      'preview shows the selected variant headline',
      (await textOf(page, 'eb-preview')).includes('Spring refresh: up to 40% off'),
    );
    const subjectCount = await page.$$eval('[data-testid^="eb-subject-"]', (els) => els.length);
    s.check(`subject options offered (${subjectCount})`, subjectCount >= 2);
    s.check('draft widget is in the transcript', await exists(page, 'eb-draft-widget'));
  },

  widgetVariantSwitch: async (s, page) => {
    await clickTestId(page, 'eb-widget-variant-variant-2');
    await waitFor(page, inPage.previewHas, 10_000, '40% off. Until Sunday.').catch(() => {});
    s.check(
      'preview follows the widget variant pick',
      (await textOf(page, 'eb-preview')).includes('40% off. Until Sunday.'),
    );
  },

  subjectPick: async (s, page) => {
    await clickTestId(page, 'eb-subject-1');
    await sleep(300);
    const subject = await page.$eval('[aria-label="Subject"]', (el) => el.value).catch(() => '');
    s.check('editor subject follows the pick', subject === 'Your upgrade is 40% off until Sunday');
  },

  manualEditPreview: async (s, page) => {
    await page.click(sel('eb-headline'));
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type(sel('eb-headline'), 'Edited live in the walk');
    await waitFor(page, inPage.previewHas, 10_000, 'Edited live in the walk').catch(() => {});
    s.check(
      'preview re-renders the manual headline edit',
      (await textOf(page, 'eb-preview')).includes('Edited live in the walk'),
    );
  },

  exportCopy: async (s, page) => {
    await clickTestId(page, 'eb-copy-html');
    await sleep(800);
    const flash = await textOf(page, 'eb-flash');
    const notice = await textOf(page, 'eb-notice');
    const copiedLabel = await page.$eval(sel('eb-copy-html'), (el) => el.textContent ?? '').catch(() => '');
    s.check(
      'copy gives an honest outcome (flash, Copied label, or blocked notice)',
      flash.includes('HTML copied') || copiedLabel.includes('Copied') || notice.includes('Copy was blocked'),
    );
    s.note(
      flash.includes('HTML copied')
        ? 'clipboard write succeeded; flash shown'
        : notice.includes('Copy was blocked')
          ? 'clipboard blocked in headless shell; the app’s fallback notice shown'
          : `copy outcome label: “${copiedLabel.trim()}”`,
    );
  },

  brokenBannerFallback: async (s, page) => {
    await openDraftByName(page, 'Webinar invite');
    await waitFor(
      page,
      () =>
        (document.querySelector('[data-testid="eb-banner-placeholder"]')?.textContent ?? '').includes(
          'Banner image unavailable',
        ),
      15_000,
    ).catch(() => {});
    s.check(
      'dead banner URL degrades to the “unavailable” placeholder',
      (await textOf(page, 'eb-banner-placeholder')).includes('Banner image unavailable'),
    );
    s.check('regenerate is offered in place', await exists(page, 'eb-banner-regenerate'));
  },

  brokenBannerRegenerateConfirm: async (s, page) => {
    await clickTestId(page, 'eb-banner-regenerate');
    await page.waitForSelector(sel('eb-confirm'), { visible: true, timeout: 30_000 }).catch(() => {});
    s.check('regenerate asks for priced consent first', await exists(page, 'eb-confirm'));
  },

  brokenBannerRegenerated: async (s, page) => {
    s.note(
      'The mock host answers with its canned placeholder image URL; it is served locally ' +
        'by this runner (no external fetch), so the pixels are a stand-in — the flow ' +
        '(confirm -> submit -> banner swaps in) is what is proven.',
    );
    await clickTestId(page, 'eb-confirm-run');
    await page.waitForSelector(sel('eb-banner-img'), { visible: true, timeout: 30_000 }).catch(() => {});
    s.check('a fresh banner image replaces the dead one', await exists(page, 'eb-banner-img'));
  },

  bannerGenerateConfirm: async (s, page) => {
    await openDraftByName(page, 'Product tips digest');
    s.check('no banner yet (prompt placeholder showing)', await exists(page, 'eb-banner-placeholder'));
    await clickTestId(page, 'eb-banner-generate');
    await page.waitForSelector(sel('eb-confirm'), { visible: true, timeout: 30_000 }).catch(() => {});
    s.check('first generation asks for priced consent', await exists(page, 'eb-confirm'));
  },

  bannerGenerated: async (s, page) => {
    s.note('Banner pixels are the mock host’s canned placeholder, served locally.');
    await clickTestId(page, 'eb-confirm-run');
    await page.waitForSelector(sel('eb-banner-img'), { visible: true, timeout: 30_000 }).catch(() => {});
    s.check('generated banner lands in the preview', await exists(page, 'eb-banner-img'));
  },

  saveAndNew: async (s, page) => {
    await openDraftByName(page, 'October newsletter');
    await clickTestId(page, 'eb-save-draft');
    await waitFor(page, inPage.flashHas, 10_000, 'Saved').catch(() => {});
    s.check('Save confirms with a flash', (await textOf(page, 'eb-flash')).includes('Saved'));
    await clickTestId(page, 'eb-new');
    await waitFor(page, inPage.currentDraftIs, 10_000, 'Untitled email').catch(() => {});
    s.check(
      '“New email” resets to a fresh draft',
      (await textOf(page, 'eb-current-draft')).includes('Untitled email'),
    );
  },

  draftsLibraryOps: async (s, page) => {
    await ensureDraftsOpen(page);
    await ensureDraftMenuOpen(page, 'walk-brief');
    await clickTestId(page, 'eb-duplicate-walk-brief');
    await waitFor(page, inPage.draftsHas, 10_000, 'October newsletter copy').catch(() => {});
    s.check(
      'duplicate adds “October newsletter copy”',
      (await textOf(page, 'eb-drafts')).includes('October newsletter copy'),
    );

    await ensureDraftMenuOpen(page, 'walk-interview');
    await clickTestId(page, 'eb-rename-walk-interview');
    await page.waitForSelector(sel('eb-rename-input'), { visible: true, timeout: 10_000 });
    await page.click(sel('eb-rename-input'));
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type(sel('eb-rename-input'), 'Dark mode launch (renamed)');
    await clickTestId(page, 'eb-rename-save');
    await waitFor(page, inPage.draftsHas, 10_000, 'Dark mode launch (renamed)').catch(() => {});
    s.check(
      'rename sticks in the library',
      (await textOf(page, 'eb-drafts')).includes('Dark mode launch (renamed)'),
    );

    await ensureDraftMenuOpen(page, 'walk-interview');
    await clickTestId(page, 'eb-delete-walk-interview'); // arms "Confirm delete"
    await clickTestId(page, 'eb-delete-walk-interview'); // confirms
    await waitFor(
      page,
      (n) =>
        !(document.querySelector('[data-testid="eb-drafts"]')?.textContent ?? '').includes(n),
      10_000,
      'Dark mode launch (renamed)',
    ).catch(() => {});
    s.check(
      'two-tap delete removes the draft',
      !(await textOf(page, 'eb-drafts')).includes('Dark mode launch (renamed)'),
    );
  },

  wallGuest: async (s, page) => {
    s.check('guest sees the sign-in action', await exists(page, 'eb-signin'));
    await typeAndSend(page, 'I want a launch email');
    await waitFor(
      page,
      () =>
        (document.querySelector('[data-testid="eb-notice"]')?.textContent ?? '')
          .toLowerCase()
          .includes('guest'),
      20_000,
    ).catch(() => {});
    s.check(
      'guest wall notice is honest',
      (await textOf(page, 'eb-notice')).toLowerCase().includes('guest'),
    );
  },

  wallConsent: async (s, page) => {
    await typeAndSend(page, 'A launch announcement, please');
    await waitFor(page, inPage.noticeHas, 30_000, 'be granted in this context').catch(() => {});
    s.check(
      'ungrantable-consent wall notice is honest',
      (await textOf(page, 'eb-notice')).includes('be granted in this context'),
    );
  },

  wallInsufficient: async (s, page) => {
    await typeAndSend(page, 'A launch announcement, please');
    await waitFor(page, inPage.noticeHas, 45_000, 'Not enough Buzz').catch(() => {});
    s.check(
      'insufficient-Buzz wall notice names the outcome',
      (await textOf(page, 'eb-notice')).includes('Not enough Buzz'),
    );
  },
};

/** Fail loudly on any catalog/handler drift, before the walk starts. */
function validateCatalog() {
  const problems = [];
  const seenIds = new Set();
  const seenFiles = new Set();
  const usedHandlers = new Set();
  const liveClasses = ['live', 'live-user-confirm', 'live-limited', 'scratch-only', 'skip-live'];
  for (const step of catalog.steps ?? []) {
    if (seenIds.has(step.id)) problems.push(`duplicate step id “${step.id}”`);
    seenIds.add(step.id);
    if (seenFiles.has(step.file)) problems.push(`duplicate screenshot file “${step.file}”`);
    seenFiles.add(step.file);
    if (!catalog.visits?.[step.visit]) problems.push(`step ${step.id}: unknown visit “${step.visit}”`);
    if (!catalog.groups?.includes(step.group)) problems.push(`step ${step.id}: unknown group “${step.group}”`);
    if (!['desktop', 'mobile'].includes(step.viewport))
      problems.push(`step ${step.id}: bad viewport “${step.viewport}”`);
    if (!liveClasses.includes(step.liveClass))
      problems.push(`step ${step.id}: bad liveClass “${step.liveClass}”`);
    if (step.executor === 'data') {
      if (!Array.isArray(step.checks) || step.checks.length === 0) {
        problems.push(`step ${step.id}: executor "data" without checks`);
      } else {
        for (const c of step.checks) {
          if (!['exists', 'absent', 'textContains'].includes(c.kind))
            problems.push(`step ${step.id}: unknown check kind “${c.kind}”`);
          if (!c.testid || !c.label) problems.push(`step ${step.id}: check missing testid/label`);
          if (c.kind === 'textContains' && typeof c.text !== 'string')
            problems.push(`step ${step.id}: textContains check missing text`);
        }
      }
    } else if (step.executor === 'code') {
      if (!step.handler || typeof HANDLERS[step.handler] !== 'function') {
        problems.push(`step ${step.id}: no implementation for handler “${step.handler}”`);
      } else {
        usedHandlers.add(step.handler);
      }
    } else {
      problems.push(`step ${step.id}: unknown executor “${step.executor}”`);
    }
  }
  for (const name of Object.keys(HANDLERS)) {
    if (!usedHandlers.has(name)) problems.push(`handler “${name}” has no catalog entry`);
  }
  // Each visit must be a single-viewport run of consecutive steps.
  let prevVisit = null;
  const closedVisits = new Set();
  for (const step of catalog.steps ?? []) {
    if (step.visit !== prevVisit) {
      if (closedVisits.has(step.visit))
        problems.push(`visit “${step.visit}” is not consecutive in the step list`);
      if (prevVisit) closedVisits.add(prevVisit);
      prevVisit = step.visit;
    }
  }
  if (problems.length) {
    console.error('tools/walk/steps.json ↔ run.mjs drift detected:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
}

function visitUrl(visitDef) {
  switch (visitDef.setup) {
    case 'unseeded':
      return `${BASE}/`;
    case 'seeded':
      return SEEDED_URL;
    case 'query':
      return `${BASE}/?${visitDef.query}`;
    default:
      throw new Error(`unknown visit setup “${visitDef.setup}”`);
  }
}


validateCatalog();

const bootedByUs = await ensureServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const interceptedExternal = [];

async function newWalkPage(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluateOnNewDocument((css) => {
    const inject = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head?.appendChild(style);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }, HIDE_DEV_CHROME);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
      void req.continue();
    } else if (req.resourceType() === 'image') {
      interceptedExternal.push(url);
      void req.respond({ status: 200, contentType: 'image/svg+xml', body: MOCK_IMG_SVG });
    } else {
      interceptedExternal.push(url);
      void req.abort();
    }
  });
  page.on('pageerror', (e) => {
    if (activeStep) {
      activeStep.errors.push(`pageerror: ${String(e).slice(0, 300)}`);
      activeStep.status = 'fail';
    }
  });
  page.on('console', (m) => {
    if (m.type() !== 'error' || !activeStep) return;
    const text = m.text().slice(0, 300);
    if (/favicon/.test(text)) return; // sandbox noise, not app signal
    activeStep.errors.push(`console: ${text}`);
    activeStep.status = 'fail';
  });
  return page;
}

async function visit(url, viewport) {
  const page = await newWalkPage(viewport);
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector(sel('eb-app'), { timeout: 30_000 });
  await sleep(900);
  return page;
}

try {
  // Iterate the catalog: consecutive steps sharing a visit run on one page,
  // in catalog order, with catalog names/files/viewports/honesty metadata.
  let i = 0;
  while (i < catalog.steps.length) {
    const visitId = catalog.steps[i].visit;
    const visitSteps = [];
    while (i < catalog.steps.length && catalog.steps[i].visit === visitId) {
      visitSteps.push(catalog.steps[i]);
      i++;
    }
    const dims = visitSteps[0].viewport === 'mobile' ? MOBILE : DESKTOP;
    const page = await visit(visitUrl(catalog.visits[visitId]), dims);
    for (const def of visitSteps) {
      await doStep(def.name, def.file, def.viewport, page, async (s) => {
        if (def.mockLimited) s.mockLimit(def.mockLimited);
        if (def.executor === 'data') await runDataChecks(s, page, def);
        else await HANDLERS[def.handler](s, page);
      });
    }
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  stopServer();
}

// ---------------------------------------------------------------------------
// baseline + pixel diff
// ---------------------------------------------------------------------------

/** % of pixels that differ between two PNG buffers (browser-canvas compare). */
async function diffPct(browserPage, aBuf, bBuf) {
  return browserPage.evaluate(
    async ([a64, b64]) => {
      const load = (src) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = src;
        });
      const [ia, ib] = await Promise.all([
        load(`data:image/png;base64,${a64}`),
        load(`data:image/png;base64,${b64}`),
      ]);
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
    },
    [aBuf.toString('base64'), bBuf.toString('base64')],
  );
}

let diffs = null;
if (isBaseline) {
  fs.rmSync(BASELINE_DIR, { recursive: true, force: true });
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const files = [];
  for (const step of results) {
    const src = path.join(OUT, step.file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(BASELINE_DIR, step.file));
      files.push(step.file);
    }
  }
  fs.writeFileSync(
    path.join(BASELINE_DIR, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), base: BASE, files }, null, 2),
  );
  console.log(`baseline saved: ${files.length} screenshots -> ${BASELINE_DIR}`);
} else if (fs.existsSync(BASELINE_DIR)) {
  const diffBrowser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const diffPage = await diffBrowser.newPage();
  diffs = [];
  const baselineOut = path.join(OUT, 'baseline');
  fs.mkdirSync(baselineOut, { recursive: true });
  for (const step of results) {
    const oldPath = path.join(BASELINE_DIR, step.file);
    const newPath = path.join(OUT, step.file);
    if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) {
      diffs.push({ file: step.file, state: 'new', pct: null });
      continue;
    }
    fs.copyFileSync(oldPath, path.join(baselineOut, step.file));
    const a = fs.readFileSync(oldPath);
    const b = fs.readFileSync(newPath);
    if (a.equals(b)) {
      diffs.push({ file: step.file, state: 'unchanged', pct: 0 });
      continue;
    }
    const pct = await diffPct(diffPage, a, b).catch(() => null);
    // 2% triage threshold: identical-code runs show ~0-1.7% raster jitter
    // (scroll positions, caret, sub-pixel text), while real layout/copy
    // changes move well past 2%. Flags triage eyeballs; they are not
    // verdicts — the taste strip is.
    diffs.push({ file: step.file, state: pct !== null && pct > 2 ? 'changed' : 'unchanged', pct });
  }
  await diffBrowser.close();
  console.log(
    `diff vs baseline: ${diffs.filter((d) => d.state === 'changed').length} changed, ` +
      `${diffs.filter((d) => d.state === 'unchanged').length} unchanged, ` +
      `${diffs.filter((d) => d.state === 'new').length} new`,
  );
}

// ---------------------------------------------------------------------------
// report + strips
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.status === 'pass' && !r.mockLimited).length;
const limited = results.filter((r) => r.status === 'pass' && r.mockLimited).length;
const failed = results.filter((r) => r.status === 'fail').length;
const pageErrors = results.reduce(
  (n, r) => n + r.errors.filter((e) => e.startsWith('pageerror')).length,
  0,
);
const consoleErrors = results.reduce(
  (n, r) => n + r.errors.filter((e) => e.startsWith('console')).length,
  0,
);
const statusLabel = (r) => (r.status === 'fail' ? 'FAIL' : r.mockLimited ? 'MOCK-LIMITED' : 'PASS');

const lines = [];
lines.push(`# Email Builder walk — ${today}`);
lines.push('');
lines.push(
  `Mock-host harness at ${BASE} (${bootedByUs ? 'booted by the walk' : 'already running, reused'}). ` +
    'No real Buzz spent; no network left localhost' +
    (interceptedExternal.length
      ? ` (${interceptedExternal.length} external request(s) intercepted and answered locally).`
      : '.'),
);
lines.push('');
lines.push(
  `**Summary:** ${passed} passed · ${limited} mock-limited · ${failed} failed · ` +
    `${pageErrors} page errors · ${consoleErrors} console errors across ${results.length} states.`,
);
lines.push('');
lines.push('| # | State | Viewport | Status | Screenshot |');
lines.push('|---|-------|----------|--------|------------|');
for (const r of results) {
  lines.push(`| ${r.n} | ${r.name} | ${r.viewport} | ${statusLabel(r)} | [${r.file}](${r.file}) |`);
}
lines.push('');
for (const r of results) {
  lines.push(`## ${r.n}. ${r.name} — ${statusLabel(r)}`);
  lines.push('');
  if (r.mockLimited) lines.push(`> Mock-limited: ${r.mockLimited}`, '');
  for (const c of r.checks) lines.push(`- ${c.ok ? '✓' : '✗ FAIL'} ${c.label}`);
  for (const n of r.notes) lines.push(`- _${n}_`);
  if (r.errors.length) {
    lines.push('', '**Errors seen during this state:**');
    for (const e of r.errors) lines.push(`- \`${e}\``);
  }
  lines.push('', `![${r.name}](${r.file})`, '');
}
if (isBaseline) {
  lines.push('## Baseline', '', 'This run refreshed the baseline in `tools/walk/baseline/`.', '');
} else if (diffs) {
  lines.push('## Visual diff vs baseline', '');
  lines.push('| State | Verdict | Pixels changed |');
  lines.push('|-------|---------|----------------|');
  for (const d of diffs) {
    lines.push(`| ${d.file} | ${d.state} | ${d.pct === null ? '—' : `${d.pct.toFixed(2)}%`} |`);
  }
  lines.push('', 'Side-by-side: [taste-strip.html](taste-strip.html).', '');
} else {
  lines.push(
    '## Visual diff vs baseline',
    '',
    'No baseline yet — create one with `npm run walk -- --baseline`.',
    '',
  );
}
fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));

const stripFigures = results
  .map(
    (r) =>
      `<figure><img src="${r.file}" alt="${r.name}"><figcaption>` +
      `<strong>${r.n}. ${r.name}</strong> · ${r.viewport} · ${statusLabel(r)}</figcaption></figure>`,
  )
  .join('\n');
fs.writeFileSync(
  path.join(OUT, 'strip.html'),
  `<!doctype html><meta charset="utf-8"><title>Email Builder walk ${today}</title>
<style>body{background:#101113;color:#e6e6e6;font-family:system-ui;margin:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}
figure{margin:0;background:#1a1b1e;border:1px solid #333;border-radius:8px;padding:8px}
img{width:100%;display:block;border-radius:4px}figcaption{padding-top:8px;font-size:13px}</style>
<h1>Email Builder walk — ${today}</h1>
<p>${passed} passed · ${limited} mock-limited · ${failed} failed · ${pageErrors} page errors · ${consoleErrors} console errors</p>
<div class="grid">${stripFigures}</div>
`,
);

if (diffs) {
  const byFile = new Map(diffs.map((d) => [d.file, d]));
  const rows = results
    .map((r) => {
      const d = byFile.get(r.file);
      const badge =
        d.state === 'new'
          ? '<span style="color:#fab005">NEW STATE</span>'
          : d.state === 'changed'
            ? `<span style="color:#ff8787">CHANGED ${d.pct?.toFixed(2)}%</span>`
            : '<span style="color:#69db7c">unchanged</span>';
      const oldImg =
        d.state === 'new' ? '<em>no baseline</em>' : `<img src="baseline/${r.file}" alt="baseline ${r.name}">`;
      return `<tr><td><strong>${r.n}. ${r.name}</strong><br>${badge}</td><td>${oldImg}</td><td><img src="${r.file}" alt="current ${r.name}"></td></tr>`;
    })
    .join('\n');
  fs.writeFileSync(
    path.join(OUT, 'taste-strip.html'),
    `<!doctype html><meta charset="utf-8"><title>Email Builder taste strip ${today}</title>
<style>body{background:#101113;color:#e6e6e6;font-family:system-ui;margin:24px}
table{border-collapse:collapse;width:100%}td{border:1px solid #333;padding:8px;vertical-align:top;width:33%}
img{width:100%;display:block}</style>
<h1>Email Builder taste strip — ${today} (baseline vs now)</h1>
<table><tr><td><strong>State</strong></td><td><strong>Baseline</strong></td><td><strong>Current</strong></td></tr>
${rows}</table>
`,
  );
}

for (const r of results) {
  console.log(
    `${String(r.n).padStart(2)}. ${r.name.padEnd(34)} ${statusLabel(r)}` +
      (r.errors.length ? `  [${r.errors.length} error(s)]` : ''),
  );
}
console.log(
  `\nreport: ${path.join(OUT, 'report.md')}\nstrip:  ${path.join(OUT, 'strip.html')}` +
    (diffs ? `\ntaste:  ${path.join(OUT, 'taste-strip.html')}` : ''),
);
if (failed > 0) process.exitCode = 1;
