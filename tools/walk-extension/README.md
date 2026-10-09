# Toil-Killer — v0.7.9

A Chrome extension (Manifest V3, loaded unpacked) that runs
toil-killer walks **against live Civitai apps** in your own
signed-in browser — in whole or in part, by step group. One
extension, an **app picker**, and a per-app step catalog (a
*binding*) per app: **Email Builder** and **Open Datasets** today.
The runner, report writer, Ship-to-S3, Auto mode, pause/stop,
screenshots, and safety machinery are shared; only the catalog and
the in-page handlers are per-app. Spec:
`../../files/toil-killer-extension-spec.md` (executor §8.3–4, report
writer §8.5, live adaptation §8.6–7 built; v0.2.1 adds the §8.8
live calibration — the acceptance run itself still to come, with
you present; v0.2.2 adds the stale-frame version handshake below;
v0.2.3 makes the step watchdog measure execution time only, so a
step parked at a §5 user halt no longer burns its fuse; v0.2.4
makes the panel's dispatch deadline honor the park too, and lets
the chat step resume on its own when your Send lands in the page —
see "Execution watchdog" and "Park & observe" below; v0.3.0 makes
the sidebar minimal — short labels, tooltips instead of explainer
paragraphs — and adds **Ship to homelab** under Report; v0.4.0
adds **Auto — no waits**: an opt-in mode that runs end to end;
v0.5.0 ships bundles **directly to homelab S3**; v0.6.0 generalizes
the extension to the app registry + per-app catalogs and adds the
Open Datasets binding; v0.7.0 adds **concurrent runs across tabs**
— per-tab run contexts, a panel that follows the tab you're
looking at, and honest screenshots for hidden tabs; v0.7.1 makes
the **target type auto-select from the current tab**; v0.7.2
makes that detection **survive service-worker restarts** — see
"Multiple tabs at once" below; v0.7.3 adds a **copyable run ID**
under Ship — see "Ship to homelab" below); v0.7.7 fixes the
Email Builder live subject-pick: it opens the copy editor before
reading the Subject field, then polls for the pick to land);
v0.7.8 polls the Email Builder export-copy outcome for up to 12
seconds instead of sampling once (see "Run the walk"); v0.7.9
makes **walk IDs name their app** (`walk-<app>-YYYY-MM-DD-HHMM`)
and adds **Auto-ship at walk end** — see "Ship to homelab" below.

For Email Builder it executes the **same step catalog** as the mock
walk (`tools/walk/steps.json`). One list, two executors, no drift:
the panel shows the catalog version + sha256 it loaded and flags
DRIFT in red if its copy ever disagrees with `tools/walk/steps.json`.
Open Datasets carries its own catalog (`steps-open-datasets.json` +
stamp) beside it; the panel re-hashes whichever catalog the picked
app loaded and shows the same ✓ sync / ⚠ DRIFT verdict.

**Safety rails (spec §5) are structural:**
- There is **no code path that clicks a price confirm** (`eb-confirm-run`,
  `dc-confirm-submit`, `dc-lora-confirm-submit`) outside Auto.
  Every in-page click goes through one primitive that refuses them.
- Priced steps stop at the confirm card and wait for **your** click
  ("Action needed" banner → you act in the page → Continue, or
  End run here).
- Consent walls are detected and recorded verbatim (text +
  screenshot), never clicked through; the run stops cleanly.
- Stateful steps run **only** against a scratch record the run itself
  creates (Email Builder: a draft renamed to `walk-scratch-<timestamp>`;
  Open Datasets: a dataset named `toil-scratch-<timestamp>-<run suffix>` — the
  containment markers); a structural id+name guard refuses any other
  record's rename/duplicate/delete/save controls. The scratch is
  deleted at run end however the run ends; a cleanup failure is
  reported loudly. Real drafts/datasets are opened read-only.
- Fail-stop: a failed check, page error, or unexpected modal stops
  the run and reports — nothing is improvised, nothing faked green.

## Install (unpacked, ~1 minute)

1. Open `chrome://extensions` in the Chrome profile where you're
   signed in to Civitai.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → pick this folder (`tools/walk-extension`).
4. Click the Toil-Killer icon; it opens the side panel.

After any rebuild of this folder, hit ↻ on the extension card and
reload the app tab. (Forgot the tab? The version handshake below
refuses to start the run and tells you — instead of hanging.)

## Run the walk

1. Open the app tab (the standalone app origin — a `*.civit.ai` host
   the manifest already matches — or the embedded civitai.com view —
   the frame is found automatically).
2. Open the panel. The **Target** app type follows the current
   tab: a tab reporting `● eb-app` selects Email Builder, one
   reporting `● dc-community` selects Open Datasets. The picker
   remains as a manual override until the next tab switch or
   navigation. Check the catalog line under the title: it must
   say **✓ sync** (if it says DRIFT, run `npm run steps:sync`
   in the app repo and reload the extension).
3. Tick the step groups you want (all by default), click
   **Run walk**. Steps stream their checks live; each executed step
   is screenshotted. **Pause**/**Stop** work mid-step.
4. If a step reaches a price-confirm card, the run stops on the
   **⏸ Action needed** banner. Click Confirm in the app yourself
   only if you want the spend; then **Done — continue**. Or
   **End run here** — the card stays as the app left it.
5. Walls / live-limited steps are reported with their reason, never
   faked green. The mock walk (`npm run walk`) owns the wall states.
   Steps that need a price confirm or a Send stop behind the
   awaiting-user banner; the outcome steps (package lands, banner
   lands) run only after **your** click + Continue.
6. Stateful steps create their own scratch record (`walk-scratch-…`
   draft / `toil-scratch-…` dataset), work only on it, and it is
   deleted when the run ends (the report says so, or names the
   leftover loudly).

### Open Datasets live run

1. Reload the extension (↻ on its card), then reload the Open
   Datasets tab so the tab picks up the current executor (the
   version handshake refuses a stale tab rather than hanging).
2. Open the panel on the Open Datasets tab; **Target** auto-selects
   Open Datasets from its `● dc-community` root. The catalog line
   must say ✓ sync.
3. Leave **Scratch drafts** ON — the create/edit/train steps run
   only on the run's own `toil-scratch-…` dataset, and run-end
   cleanup deletes it (with its item, votes, snapshots, and LoRA
   records) through the app's owner Delete action.
4. Optional: tick **Auto — no waits** and set the Buzz cap. Auto
   confirms the Train and test-generation cards only at/under the
   cap; over-cap, unpriced, insufficient, and consent states fall
   back to you or stop the run.
5. Tick the groups (all seven for the full walk) and **Run walk**.
   At a price card (manual mode), click Confirm in the app yourself
   if you want the spend, then **Done — continue** — or **End run**.
6. When it finishes, **🚀 Ship to homelab** (or ⬇ Bundle).

As of v0.7.6 the scratch step contributes and votes **two** distinct
items (distinct blob references and captions), and the Train step
records per-item snapshot/contributor evidence plus the estimate
branch (`dc-confirm` / `dc-unquoted` / `dc-insufficient` / consent /
disabled) with the full detail text. For a diagnostic run, leave Auto
OFF so a quoted card stops the walk with nothing submitted.

As of v0.7.7 the Email Builder subject-pick step opens the copy
editor (Edit copy) before reading the Subject field and polls until
the editor shows the pick, instead of sampling an unmounted field
once and reporting an empty-to-empty result on a healthy pick.

As of v0.7.8 the Email Builder export-copy step polls for any of
the app's honest copy outcomes (flash, Copied label, or blocked
notice) for up to 12 seconds instead of sampling once after
800 ms, so a slow or late-refused clipboard write in the live
frame is graded on its real outcome.

A clean grade looks like: every screen step PASS (Explore, dataset
detail, scratch create/edit, Train confirm + outcome, LoRA detail,
test-generation confirm + outcome, ledger); walls PASS on the mock
harness and, on live, honestly `LIVE-LIMITED` where the state
cannot be manufactured (guest on a signed-in session,
insufficient-Buzz, a LoRA that needs a published run); the report's
Scratch section names the `toil-scratch-…` dataset and records
`cleanup: deleted` with no leftover line. Anything else — a FAIL,
a consent wall recorded verbatim, a leftover scratch dataset — is
the grade, stated as-is.

## Multiple tabs at once (v0.7.0)

Runs live in **per-tab contexts**: each tab owns its target, app
binding, run state, scratch, and report bundle. Open two app tabs,
start a walk on each — they execute **concurrently**, and no run's
halt, error, or price gate touches another's. The panel renders
the context of the tab you're looking at: switch tabs and the
whole panel (groups, step list, progress, banner, Bundle/Ship)
swaps to that tab's run — running, finished, or not started. The
**Target** list marks every tab's state (`▶ running`,
`⏸ action needed`, `✓ done`, `✗ done`), and picking a tab there
is the manual override if you don't want to switch browser tabs.

- **Pause/Stop, the app picker, and Bundle/Ship act on the viewed
  tab's run.** Ship ships the viewed tab's bundle. A step parked at
  a price card on a hidden tab waits there; its tab shows
  `⏸ action needed` until you look at it and decide.
- **Screenshots are pinned to the run's own tab.** A screenshot can
  only photograph the visible tab of a window, so when a run's tab
  isn't visible at shot time the step is graded from the page
  itself and the report says `screenshot unavailable` — the missing
  PNG is named in the report and in the ship manifest's
  `missingScreenshots`, never silently dropped and never filled
  with another tab's pixels. Focus is never stolen for a shot.
  When you return to that tab after the run, each missing screenshot is retaken once from the current view and labelled with its retake time; grades do not change, and retakes made after Ship stay local until re-shipped.
  For full screenshots on concurrent live walks, put the tabs in
  **different windows** — each window's visible tab shoots normally.
- **Closing a tab mid-run** aborts only that run: the report
  records the abort and the scratch-cleanup outcome (cleanup is
  attempted and named honestly if it couldn't run). The closed
  tab's context stays in the Target list so its bundle can still
  ship.
- **Settings stay panel-global** (§8.7): the scratch/Auto/cap
  toggles and per-app group selections persist as before, and each
  run snapshots them when you press Run — flipping a toggle never
  changes a run already in flight on any tab. Scratch names are
  unique per run (a same-second collision waits for a free stamp,
  and Open Datasets names carry a run suffix), and cleanup is
  id-guarded per run, so concurrent runs never share a containment
  target. Note the honest limit: two tabs walking the *same* app on
  the *same* account share that account's library — scratch ids
  keep the runs apart, but the account state is genuinely shared.

### Auto target type (v0.7.1)

The app type follows the tab. Whenever the viewed tab changes —
tab switch, window focus, Target pick, or a navigation completing
— the panel reads which app root that tab's frames report
(`eb-app` or `dc-community`) and selects that binding, catalog,
and group list automatically; the status line under Target names
the choice (`Auto: … · eb-app`). The app picker stays available
to pre-stage a type, but auto-detection wins on the next tab
switch or navigation.

- If a tab somehow reports **both** roots, the choice is
  deterministic — frames are considered top-first, then by frame
  id (one frame reporting both: registry order, Email Builder
  first) — and the status line says which rule decided.
- A **run in flight is never rebound**: if its tab navigates to
  the other app, the run keeps the binding bound at Run and the
  status line shows `Tab app: … · Run app: … (bound at Run)`.
  Only the idle view follows the tab.
- A tab with **no app root** shows `No app in this tab`: the type
  is left unselected, no catalog is primed, and **Run is
  disabled** — a walk cannot start against the wrong app.
- **Detection self-heals (v0.7.2).** The hub's frame registry
  lives in the MV3 service worker's memory and is fed by load-time
  announcements, so a routine worker restart used to leave every
  already-loaded tab reading `No app in this tab`. Now, when the
  registry holds no app root for a tab, the hub probes its frames
  on demand (resident probe first; a scripting DOM check when no
  script answers, e.g. a script orphaned by an extension reload)
  and refills the registry — no tab reload needed for detection.
  Probing happens on request, never on a timer, and an empty
  result is cached briefly so repaints don't probe-storm.
  (Running a walk on a tab whose script was orphaned by an
  extension reload still asks for a tab reload — that's the
  version handshake below, unchanged.)

## Version handshake (v0.2.2 — stale-frame guard)

After you reload the extension, an app tab you didn't reload still
holds the **old** content script: it answers the panel's probes (so
the app shows as found) but never executes the new step messages —
a run would sit at RUNNING on step 1 until the 180-second dispatch
timeout. v0.2.2 makes that failure instant and self-explanatory:

- Every probe/announce response and every step record carries the
  executor build, read from the extension's own manifest at runtime
  (never a hardcoded copy).
- Before a run's first step, the panel asks the app frame for its
  build and compares it with its own manifest version. Mismatch or
  no answer → **the run does not start**; the verdict names both
  versions (when the frame reports one) and says what to do.
- If a dispatched step produces no progress for ~20 seconds, its
  row is annotated with the likely cause. (Since v0.2.4 the
  dispatch deadline itself is progress-aware — see "Park &
  observe" below.)

**Recovery:** reload the app tab (so it injects the current content
script), then Run again.

## Execution watchdog (v0.2.3 — user halts are not runaways)

Each step runs against a 150-second watchdog so a genuinely wedged
handler fails the step instead of hanging the run. The budget now
measures **execution time only**: paused time never counted, and
neither does time parked in a §5 user halt (a step that typed a
chat turn and waits for your Send click, or a priced step waiting
on you). A deliberate park is decided solely by your **I did it —
continue** / **End run here** action, however long you take — the
same way the price-confirm gates already wait indefinitely. A step
that is really executing still fails at 150s of execution, and the
step error says so ("step exceeded 150s watchdog (execution time;
pauses and user halts don’t count)").

Before v0.2.3 the fuse counted park time too: on the first full
live run, `interview-chat-turn` parked correctly at its Send halt
but failed when nobody acted within 150s, and the fail-stop then
skipped everything after it.

## Park & observe (v0.2.4 — the dispatch honors the park; Send resumes itself)

Two defects from the second live run, one theme: a deliberate
user park must be invisible to every deadline, and the user must
not have to tell the runner what the page already shows.

- **Progress-aware dispatch deadline.** The panel used to race each
  step dispatch against a flat 180 seconds: on the second live run
  the in-page park was already unbounded (v0.2.3), but the *panel*
  still shot the parked dispatch at 180s ("executor did not respond
  within 180s") while the user was mid-click. Now a step parked
  awaiting you has **no dispatch deadline at all** — it ends only
  when the park resolves (your Resume/End, Stop, or the page-side
  observation below), and its record returns then. Any other
  dispatch gets 180s of *silence*, not wall-clock: progress events
  streaming from the page keep resetting the clock, so a long,
  alive step is never shot; a truly dead one still fails with
  wording that says what was measured.
- **Auto-resume on the observed act.** The chat step's Send halt
  no longer needs the panel's Resume: the executor watches the
  transcript, and when the typed turn appears there as a sent user
  turn, the step resumes on its own and the banner retires itself.
  Resume/End still win whenever clicked first; Stop still wins
  over a late observation. The runner still never clicks Send.
- **Live grading of the sent turn is state-based.** After your
  send, the step checks the typed turn is in the transcript (yours,
  not the runner's), that an assistant reply actually followed it,
  and notes the brief's state verbatim. If the app answers with
  its own no-reply note instead, the step ends `live-limited`
  with that note quoted — a reply is never faked, and the mock's
  no-reply assertions are never the live pass condition.
- **Generation waits are state-aware (v0.7.4).** `bundle-outcome`
  (and the live chat-turn and banner outcomes) no longer grade on
  a fixed clock: while the app reports working (`eb-typing`), the
  wait extends to 5 minutes. Still working at the ceiling, the
  step ends `LIVE-LIMITED` — the confirm's Buzz was spent, the
  outcome is unknown — never passed, never called failed on
  evidence that only shows a generation in flight.

## Settings (§8.7 — persisted toggles)

- **Allow scratch drafts** (default ON): OFF skips the stateful
  steps and keeps the whole run read-only.
- **Auto-ship at walk end** (default OFF): ships each finished
  run's bundle automatically — see "Ship to homelab".
- **Step-group selections** persist too. Both live in
  `chrome.storage.local` (extension settings only) and every report
  header prints the states the run executed under.

Mock rehearsal (optional): run `npm run dev:harness`, open
`http://localhost:5186`, paste the output of `npm run seed:url` into
the panel's **Seeded URL** field, and run — the panel navigates the
tab through the harness visits exactly like the mock walk does.

## The walk report (§8.5)

When a run finishes (or stops), the **Report** block turns the
run's records + screenshots into the same artifact family the mock
walk produces, and downloads them as one bundle via
`chrome.downloads`:

```
Downloads/<bundle folder>/           (default: toil-killer/walk-<app>-YYYY-MM-DD-HHMM)
├── report.md
├── strip.html
├── taste-strip.html
├── 01-first-run.png …               (catalog file names, executed steps only)
└── baseline/01-first-run.png …      (baseline copies, only when a baseline was imported)
```

- **report.md** — same layout as the mock walk (summary line,
  per-step table, per-step checks/notes/errors verbatim), with
  live-truthful labels (PASS / FAIL / SKIPPED / LIVE-LIMITED /
  AWAITING-USER-ENDED — never the mock's), the catalog version +
  sha256 (from `steps.sync.json`), target URL/frame, every
  awaiting-user event (card reached → you continued / ended), the
  persisted toggle states (§8.7) in the header, a **Scratch drafts**
  section (what was created, what cleanup deleted, or the leftover
  named loudly), and where + why the run stopped if it stopped
  early. It always carries the §5 line: Send/confirm never clicked
  by the runner; spends only via your own clicks.
- **strip.html** — screenshot grid of the executed steps.
- **taste-strip.html** — baseline vs current, side by side. Pixel
  compare is the mock walk's canvas diff (400px downscale, per-channel
  >16); over **2%** different is flagged CHANGED — a triage flag for
  your eyeball, not a verdict. With no baseline imported it says
  exactly that and claims no comparison.

**Baselines:** *Import baseline PNGs…* reads the 22 PNGs of a
mock-walk baseline (`tools/walk/baseline/`) or of a previous live run
into memory only (nothing is stored after the panel closes).
*Save this run as baseline* downloads the run's PNGs plus a
`manifest.json` (same shape as the mock walk's) into
`<bundle folder>-baseline/`, ready to re-import later.

## Auto mode (v0.4.0)

Governing statement, in the owner's words (2026-10-06): *"also
should have an option to bypass waiting for user so it can run end
to end."* That statement outranks the codified wording around it —
this README (like the spec it descends from) is a codification of
the owner's statements, not an authority over them; where a
paraphrase and the original statement diverge, the statement wins
and the codification gets fixed to match.

**Auto — no waits** (Walk block, OFF by default) is that option:
with it on, a walk bypasses waiting for the user and runs end to
end — the interview step clicks Send itself, and a price-confirm
card is auto-confirmed **only when its stated Buzz price is at or
under the cap** next to the toggle (default 150). The cap is a
limit on the option, not a condition of it: over-cap or unpriced
cards fall back to the manual banner, so it never spends past the
cap you set. Consent walls still stop the run; Auto never clicks
through one. The cap and toggle persist, are read once at Run, and
are printed in the report header; every auto-confirm is recorded
in Run events with its price, and the report's safety line states
the mode truthfully instead of claiming the runner clicked
nothing.

## Ship to homelab (v0.5.0 — direct to S3)

**🚀 Ship to homelab** uploads the bundle straight to the homelab
MinIO bucket `toil-killer-runs` (homelab-infra #961): one SigV4 PUT
per file at `https://toil-s3.zacx.dev/toil-killer-runs/<bundle>/`,
each carrying `x-amz-checksum-sha256` (base64 of the raw digest) so
the server itself rejects a corrupted upload, and
`ship-manifest.json` last — its hashes vouch for everything before
it. Throughput through the CDN route is slow (tens of seconds for a
full bundle); the panel shows per-file progress.

The access key (`toil-killer-svc`) is **write-only**: PutObject on
that bucket, nothing else — no read-back, so the server checksum is
the verification. Save the delivered secret once in the extension's
**options page** (endpoint/bucket/key prefilled); it lives only in
`chrome.storage.local` on that browser, never in code, a report, or
a bundle. Rotate/revoke: `scripts/provision-toil-killer-s3.sh
--rotate` / `--revoke` in the infra repo.

No secret saved? Ship falls back to the v0.3.0 behavior: bundle +
manifest downloaded, handoff prompt copied, Muse pushes via the
private repo path instead.

After a successful Ship, the panel shows the run ID (the bundle
folder's leaf name) with a copy button — paste it to Muse to point
at the exact run.

**Run IDs name their app (v0.7.9):** the default bundle folder is
`toil-killer/walk-<app>-YYYY-MM-DD-HHMM`, where `<app>` is the slug
of the binding that ran the walk (`email-builder`, `open-datasets`,
derived from the registry id — a future binding names its own runs
the same way). The run ID shown after Ship, the S3 key prefix, and
the homelab-bridge folder (`/v1/toil-runs/<id>`) are all that leaf.
Runs shipped before v0.7.9 keep their `walk-YYYY-MM-DD-HHMM` IDs —
nothing is renamed retroactively. If two runs of the same app stamp
their folders in the same minute (two tabs), the later claim earns
a `-SS` suffix so a Ship never overwrites another run's bundle.

**Auto-ship at walk end (v0.7.9)** (Walk block, OFF by default,
persisted, snapshotted at Run like Auto): when a run reaches a
completed end state — finished, fail-stopped, or ended at an
action point — its own tab's bundle ships itself once through the
same Ship path (S3 with a saved secret, else Downloads +
clipboard). A run that never started (version-handshake abort)
ships nothing, and a closed tab cannot ship. A failed auto-ship
says so in the ship status and leaves **🚀 Ship to homelab**
available; it never retries silently. Screenshots retaken after an
auto-ship stay local until a re-ship, exactly as after a manual
Ship.
## Step catalog sync

```bash
npm run steps:sync    # copy tools/walk/steps.json -> this folder + hash stamp
npm run steps:check   # exit 1 if the extension copy drifted from the source
```

The extension copy is byte-identical; `steps.sync.json` records the
source sha256. The panel re-hashes what it loaded and displays the
verdict next to the catalog version, so drift is visible at a glance.

## Diagnostics (the P0 spike probes)

Kept under **Diagnostics** in the panel, unchanged:
1. **Injection** — scans every frame, names the one with the app.
2. **Drive** — types probe text into the chat box and clears it.
   Never clicks Send.
3. **Capture** — one `captureVisibleTab` PNG of the visible tab.
4. **Embedded-view diagnosis** — inventories how the app frame is
   built on civitai.com and tries both doors (resident probe +
   script injection) into every frame.

## Live-mode assertions (§8.8 calibration — account-shaped, not seed-shaped)

On a real origin the handlers assert **state**, not the mock seed's
draft names or canned strings (spec §6's intent). Draft names on your
account are recorded as data, never asserted. On the localhost
harness the mock bodies run byte-identical — the mock path did not
move; live branches engage only off-harness, or when the panel's
**Force live-mode assertions** override is ticked (proof rehearsal;
printed in the report header when used).

| Step | Live assertion (state-based) |
|---|---|
| first-run | App shell + transcript render; the currently open draft is named in the notes verbatim. The seeded “Untitled email” / greeting wording is not asserted. |
| seeded-library | Drafts card renders and lists ≥1 real draft; count + names recorded in the notes, not asserted. |
| interview-draft-opened | Opens the first draft with no package (currently open draft first); header names it, transcript renders, brief badge read verbatim. No mid-interview draft → `live-limited` with the reason (not a fail). |
| interview-chat-turn | Unchanged (types, halts for your Send click) — but if interview-draft-opened reported its premise unmet, this reports the dependency as `live-limited` instead of typing into whatever is open. |
| brief-ready | Opens the first draft whose brief badge reads “ready” and still awaits its package; asserts the badge + the “generate my email package” next step + enabled Generate. (A ready draft that already generated is a different state — its chat raises post-package controls, not this step's premise.) No such draft → `live-limited`; the bundle chain then reports the same dependency instead of failing. |
| finished-preview + chain (variant switch, subject pick, manual edit, export copy) | Operate on the first draft that actually shows a package (widget / banner / preview). Strings are never matched to the seed: variant switch and manual edit assert the preview **changed / re-rendered**; subject pick asserts the editor Subject **equals the picked option** (read from the page). No qualifying draft → the whole chain reports one `live-limited` dependency reason, and the run continues to the next group. |
| banner-generate-confirm | Opens the first draft showing the banner prompt placeholder; reaches the priced card and stops (§5 unchanged). None → `live-limited`. |
| bundle chain, scratch lifecycle, walls, consent detection | Unchanged. Scratch steps still run only on the run's own `walk-scratch-…` draft. |

A **permanently live-limited honestly**: none known yet — every §6
behavior above has a state-based live expression. If the acceptance
run (§8.8) surfaces one that doesn't, it will be reported here with
its reason rather than faked.

## Headless proof

```bash
node tools/walk-extension/proof/proof-runner.mjs
```

Boots (or reuses) the mock harness and proves, through the real
panel UI: catalog hash matches `tools/walk/steps.json`; first-run +
seeded-library pass; walls report skip-live; the report bundle's
contents match the run (PNG names, summary counts, strip references,
live labels, the §5 line), an imported identical baseline diffs
unchanged while a doctored one flags CHANGED; the bundle group halts
at the price-confirm without clicking it, and the halted run's report
says where and why it stopped; the spike probes still pass; the
scratch lifecycle creates/guards/deletes its draft with real drafts
read-only; consent walls are detected verbatim; **and (§8.8) the
live-branch run**: with the proof override on, the full catalog
runs account-shaped against the seed as data (15·0·3·4 since
v0.2.4 — see below) — 6 library names
recorded, brief matched by state, preview chain proven by
before/after comparison — and a no-qualifying-draft run reports the
chain `live-limited` while later groups still pass. **v0.2.2:** the
inject-probe payload and every step record carry the executor build
(== the manifest version, read at runtime), and the panel source
contains the pre-run version gate. The stale-frame case itself is
not rehearsed headlessly — it needs an old build sitting in the tab;
the gate is asserted present and its payloads proven, and the
failure it prevents was observed live (§8.8 first attempt).
**v0.2.3:** the watchdog accounting is driven for real through a
localhost dev hook — a never-settling handler under a 1.5s fuse
while a user park is held 2.5s stays un-fired through the park and
fails once execution resumes. The real 150s fuse is the same
accounting; it is not waited out in real time.
**v0.2.4:** the dispatch liveness accounting is driven on the real
panel with stub sources under a 1s fuse (parked silence never
fires; unparked silence fires; flowing progress resets); an
interview run where the proof clicks only Send — never the panel's
Resume — resumes on its own and reaches the live post-send
grading; and Stop during a park returns the step's record with no
timeout. In that live run (and in §8.8's), `interview-chat-turn`
ends `live-limited` on this harness: the mock host returns no text
outputs, so the app answers with its honest no-reply note and
there is no assistant reply to grade — the settlement is stated
on the step, verbatim. A real reply on a real account is the one
state this harness cannot manufacture; the step's reply-graded
PASS is asserted in code and first exercised on Zacx's account.
Mock-only — no live origin, no Buzz.

### Open Datasets proof (v0.6.0)

```bash
node tools/walk-extension/proof/proof-runner-open-datasets.mjs
```

Run it **sequentially** with the proof above, never in parallel —
both app harnesses serve `localhost:5186`. It boots the Open
Datasets mock harness with the demo seed plus the deterministic
`training=published` scenario — the panel auto-selects Open
Datasets from the tab's `dc-community` root — and runs the full
catalog: Explore, dataset detail, scratch
create/edit/contribute/vote, Train price card → gated outcome,
LoRA detail, test-generation card → gated outcome, and the ledger
— all state-based (counts, quotes, and names read as data). Auto
is ON for the proof (cap 1000) so the price cards are confirmed
under the owner's opt-in against the mock host; run-end cleanup
must delete the `toil-scratch-…` dataset, and the report must say
so. A second run covers the walls: guest and insufficient-Buzz
PASS on their manufactured harness states; consent ends
`LIVE-LIMITED` with the wall text verbatim, never clicked.

### Concurrency proof (v0.7.0)

```bash
node tools/walk-extension/proof/proof-runner-concurrent.mjs
```

Boots both harnesses at once (Email Builder on `:5186`, Open
Datasets on `:5187` — the manifest matches the second localhost
port for exactly this) and runs a walk on each tab **at the same
time** from one panel: Target marks both `▶ running`, the view
swaps whole between the runs as the active tab changes, both
finish with their single-run verdicts and no cross-app step ids,
each run's scratch is created and cleaned up under its own
containment marker, the front tab's steps all carry real
screenshots, and the hidden tab's later steps carry the
`screenshot unavailable` note with the missing PNGs named in the
report and the ship manifest's `missingScreenshots`. It also
proves the v0.7.1 auto target type: bringing each harness tab to
the front flips the app type, catalog, and groups with no picker
interaction, and a no-app tab leaves the type unselected with Run
disabled. What it cannot prove headlessly: two real browser
windows (side panels are per-window instances; nothing syncs
panels across windows, and none is claimed).

## Files

- `manifest.json` — MV3. Content scripts stay scoped to `*.civit.ai`,
  `civitai.com`, and the local mock harnesses (`localhost:5186` for
  either app run alone, `localhost:5187` so both can run at once —
  see the concurrency proof).
  `host_permissions` additionally carries `<all_urls>` for one reason
  only: `captureVisibleTab` accepts `<all_urls>` or a live `activeTab`
  grant, and the grant dies on every tab reload (proven live, v0.0.4).
  The `downloads` permission (v0.1.1) is the report bundle's only way
  out; it is used by the panel page directly, never by a content
  script.
- `steps.json` + `steps.sync.json` — the Email Builder catalog copy
  + stamp (generated; do not hand-edit — edit `tools/walk/steps.json`
  and run `npm run steps:sync`).
- `steps-open-datasets.json` + `steps-open-datasets.sync.json` — the
  Open Datasets catalog + stamp (the panel re-hashes it the same way).
- `content.js` — spike probes + the step executor (polling checks,
  per-app in-page handlers, honesty gates, the click-primitive rail).
- `background.js` — frame registry, app-frame finder, diagnosis,
  screenshot service.
- `panel.html` / `panel.js` — side panel: app picker, per-app catalog
  display, target discovery, run protocol (run/pause/stop, per-step
  status, awaiting-user), the §8.5 report writer (report/strip/
  taste-strip generation, baseline import + canvas diff, downloads
  bundle), diagnostics.
- `icons/` — the steps-to-check mark.
- `proof/` — the headless proof runners (Email Builder +
  Open Datasets; run those two sequentially — both app harnesses
  use :5186 — plus the concurrency proof, which serves them on
  :5186 + :5187 simultaneously).

## Remove

`chrome://extensions` → **Remove** on “Toil-Killer”.
It stores nothing anywhere; the frame registry lives in memory only.
