#!/usr/bin/env node
// Sync the shared step catalog into the toil-killer extension.
//
//   node tools/walk/sync-steps.mjs           copy + stamp
//   node tools/walk/sync-steps.mjs --check   verify only; exit 1 on drift
//   npm run steps:sync / npm run steps:check
//
// tools/walk/steps.json is the single source of truth (spec §4.1). The
// extension cannot read the repo at runtime, so it ships a byte-identical
// copy plus a stamp (steps.sync.json) carrying the sha256 of the source
// bytes. The panel re-hashes the copy it loaded and displays version +
// hash + sync state, so drift between the mock runner and the extension
// is visible at a glance; --check makes it a hard failure in a terminal.
//
// Sync is one-way: walk -> extension. Nothing here edits steps.json or
// run.mjs.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(APP_DIR, 'tools', 'walk', 'steps.json');
const EXT_DIR = path.join(APP_DIR, 'tools', 'walk-extension');
const DST = path.join(EXT_DIR, 'steps.json');
const STAMP = path.join(EXT_DIR, 'steps.sync.json');
const CONTENT_JS = path.join(EXT_DIR, 'content.js');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const check = process.argv.includes('--check');

const srcBytes = fs.readFileSync(SRC);
const srcHash = sha256(srcBytes);
const catalog = JSON.parse(srcBytes.toString('utf8'));

// Light catalog sanity (the runners do their own deep validation; this
// keeps a malformed catalog from being stamped as "in sync").
const problems = [];
if (!Array.isArray(catalog.steps) || catalog.steps.length === 0) problems.push('catalog has no steps');
if (!Array.isArray(catalog.groups) || catalog.groups.length === 0) problems.push('catalog has no groups');
const liveClasses = ['live', 'live-user-confirm', 'live-limited', 'scratch-only', 'skip-live'];
for (const s of catalog.steps ?? []) {
  if (!liveClasses.includes(s.liveClass)) problems.push(`step ${s.id}: bad liveClass "${s.liveClass}"`);
  if (s.executor === 'data' && (!Array.isArray(s.checks) || s.checks.length === 0))
    problems.push(`step ${s.id}: data executor without checks`);
  if (s.executor === 'code' && !s.handler) problems.push(`step ${s.id}: code executor without handler`);
  if (!catalog.groups?.includes(s.group)) problems.push(`step ${s.id}: unknown group "${s.group}"`);
}
if (problems.length) {
  console.error('catalog problems:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

// Handler coverage: which catalog code steps have an in-page
// implementation in the extension executor today. Steps gated by
// liveClass (skip-live / live-limited / scratch-only) never reach a
// handler; ungated steps without one report skipped with a §8.6 note
// at run time — never improvised.
let inPage = new Set();
try {
  const src = fs.readFileSync(CONTENT_JS, 'utf8');
  const m = src.match(/const IN_PAGE_HANDLER_NAMES = \[([^\]]*)\]/);
  if (m) inPage = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
} catch { /* content.js absent — coverage prints empty */ }
const codeSteps = catalog.steps.filter((s) => s.executor === 'code');
const gatedClasses = ['skip-live', 'live-limited', 'scratch-only'];
const gated = codeSteps.filter((s) => gatedClasses.includes(s.liveClass));
const runnable = codeSteps.filter((s) => !gatedClasses.includes(s.liveClass));
const deferred = runnable.filter((s) => !inPage.has(s.handler));

if (check) {
  const errs = [];
  if (!fs.existsSync(DST)) errs.push('extension steps.json missing — run npm run steps:sync');
  if (!fs.existsSync(STAMP)) errs.push('steps.sync.json missing — run npm run steps:sync');
  if (!errs.length) {
    const dstHash = sha256(fs.readFileSync(DST));
    const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    if (dstHash !== srcHash) errs.push(`extension copy drifted (copy ${dstHash.slice(0, 12)}… ≠ source ${srcHash.slice(0, 12)}…)`);
    if (stamp.sha256 !== srcHash) errs.push(`stamp drifted (stamp ${String(stamp.sha256).slice(0, 12)}… ≠ source ${srcHash.slice(0, 12)}…)`);
    if (stamp.catalogVersion !== catalog.version) errs.push('stamp catalogVersion mismatch');
  }
  if (errs.length) {
    console.error('steps catalog DRIFT:\n' + errs.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  console.log(`steps catalog in sync: v${catalog.version} · ${catalog.steps.length} steps · sha256 ${srcHash.slice(0, 12)}…`);
} else {
  fs.copyFileSync(SRC, DST);
  const stamp = {
    app: catalog.app,
    catalogVersion: catalog.version,
    stepCount: catalog.steps.length,
    groupCount: catalog.groups.length,
    sha256: srcHash,
    source: 'tools/walk/steps.json',
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2) + '\n');
  console.log(
    `synced steps.json -> tools/walk-extension/ (v${catalog.version} · ${catalog.steps.length} steps · sha256 ${srcHash.slice(0, 12)}…)`,
  );
}
console.log(
  `handlers: ${codeSteps.length} code steps · ${gated.length} gated by liveClass (not run) · ` +
    `${runnable.length - deferred.length} with in-page handlers` +
    (deferred.length ? ` · deferred to §8.6: ${deferred.map((s) => s.handler).join(', ')}` : ' · none deferred'),
);
