// TEST ONLY. The per-test in-memory document store `./test-setup.ts`
// installs, plus the legacy-storage tripwire it arms.
//
// Every jsdom test starts with a FRESH `createFakeStorage` (signed-in
// `dev-viewer`, the committed manifest) wired in through
// `configureDocumentStorage`, so <App/> reads and writes the private `kv`
// collection exactly as production does — only the transport underneath is
// in-memory. A test seeds it with `seedKv(testDocStore(), { … })`, in the
// copy script's `{ value }` shape.

import type { FakeStorage } from '@civitai/sdk/testing';

import { configureDocumentStorage } from './email/doc-storage.js';
import { createAppFakeStorage } from './email/fake-doc-storage.js';

let current: FakeStorage | null = null;

/** The current test's document store. */
export function testDocStore(): FakeStorage {
  if (current === null) throw new Error('testDocStore() called outside a jsdom test');
  return current;
}

/** Install a fresh store (called from test-setup's beforeEach). */
export function installTestDocStore(): FakeStorage {
  const fake = createAppFakeStorage();
  current = fake;
  configureDocumentStorage(async () => fake.storage);
  return fake;
}

export function uninstallTestDocStore(): void {
  current = null;
  configureDocumentStorage(null);
}

/**
 * 🔴 THE LEGACY STORE MUST BE UNREACHABLE. Since 0.2.0 nothing may speak the
 * legacy per-viewer KV — neither its bridge messages (`APP_STORAGE_GET|SET|
 * DELETE|LIST|QUOTA`, which the blocks-react mock host would otherwise answer
 * SUCCESSFULLY, hiding a regression) nor its REST routes
 * (`/api/v1/blocks/app-storage/*`). test-setup records every block→host
 * message and every fetch; `assertNoLegacyStorage` fails the test loudly if
 * either touched the legacy store.
 */
export const LEGACY_BRIDGE_TYPE = /^(APP_STORAGE_|SHARED_STORAGE_)/;
export const LEGACY_ROUTE = /\/blocks\/(app-storage|shared-storage)\//;

const legacyHits: string[] = [];

export function recordLegacyHit(what: string): void {
  legacyHits.push(what);
}

export function takeLegacyHits(): string[] {
  return legacyHits.splice(0, legacyHits.length);
}
