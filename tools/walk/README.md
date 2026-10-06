# Email Builder walk — the toil-killer

Drives the Email Builder through its core flows headlessly against the
**mock host** (no real Buzz, no network beyond localhost) and leaves behind
screenshots, a Markdown report, and a contact strip for every meaningful
state. Built so a review pass never starts with clicking around the browser
or typing dummy data.

## The three commands

```bash
npm run walk              # walk + report; diffs against the baseline if one exists
npm run walk:baseline     # walk, then save this run's screenshots as the baseline
npm run seed:url          # print a URL that opens the harness pre-loaded with the seed
```

Run artifacts land in
`../../files/app-review/email-builder/walk-<YYYY-MM-DD>/`:

- `report.md` — per-state verdicts, assertions, errors, mock limits
- `strip.html` — every screenshot in walk order, one page
- `taste-strip.html` — baseline vs current side-by-side (normal runs only,
  once a baseline exists)
- `NN-<state>.png` — the screenshots; `baseline/` holds the copied baseline
  set the taste strip compares against

`npm run walk -- --out <dir>` overrides the output directory;
`EB_WALK_BASE` overrides the harness URL (default `http://localhost:5186`).

## The seed (`seed.mjs`)

`WALK_SEED` is a fixed, deterministic dataset of five drafts at different
stages — interview mid-flight, brief ready, package without banner, finished
with banner, finished with a dead banner URL — loaded through the harness's
own mechanism: the SDK mock host reads `?seed=<JSON>` into its storage seed
(`readMockHostUrlOptions`), and `src/Harness.tsx` merges it over the
screenshot rig's demo draft. Mock storage is in-memory per page load, so
every visit re-seeds identically; re-runs are idempotent by construction.

To browse the seeded app by hand: `npm run dev:harness` in one terminal,
`npm run seed:url` in another, open the printed URL. (The dead-banner URL
assumes the default port 5186.)

## Honesty rules baked in

- Chat replies and bundles are **mock-limited**: the mock host returns
  snapshots with no model text, so those steps verify the app's honest
  no-reply terminal state (an in-transcript outcome note) and are flagged
  `MOCK-LIMITED` in the report — never faked green end-to-end.
- Generated banners use the mock host's canned placeholder URL; the runner
  intercepts it and serves a clearly-labeled MOCK image locally so no
  traffic leaves localhost.
- Page errors and console errors fail the step they occurred in and are
  listed in the report. Zero is reported only when zero occurred.
- Exit code is 1 when any step fails.

## Step list

22 states: first run · seeded library · interview draft · chat turn
(mock-limited) · brief ready · bundle confirm · bundle outcome
(mock-limited) · finished preview · widget variant switch · subject pick ·
manual edit → preview · copy HTML · broken-banner fallback · regenerate
confirm · regenerated · banner generate confirm · banner generated ·
save-and-new (mobile) · library duplicate/rename/delete (mobile) · guest,
ungrantable-consent, and insufficient-Buzz walls (mobile).
