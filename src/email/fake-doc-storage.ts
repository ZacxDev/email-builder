/**
 * Email Builder — an in-memory document store for the mock-host
 * harness and the tests. DEV/TEST ONLY: production gets its client from
 * `./doc-storage.ts`.
 *
 * It is the SDK's own `createFakeStorage` (`@civitai/sdk/testing`): the real
 * client over an in-memory server that enforces the server's rules against the
 * COMMITTED manifest — so a collection the manifest stops declaring fails here
 * as `collection_not_declared` instead of passing against a phantom store.
 * The blocks-react mock host cannot stand in: it answers the bridge only, and
 * the document store is not on the bridge.
 */

import { createFakeStorage, type FakeStorage, type FakeStorageOptions } from '@civitai/sdk/testing';

import manifestText from '../../block.manifest.json?raw';
import { KV_COLLECTION, type KvDocument } from './kv-store.js';

interface ManifestStorageView {
  scopes?: string[];
  storage?: unknown;
}

/** The committed manifest's scopes + storage declaration. */
export function committedManifest(): ManifestStorageView {
  const m = JSON.parse(manifestText) as ManifestStorageView;
  return { scopes: m.scopes, storage: m.storage };
}

/** The fake's signed-in viewer (the mock host's default viewer is `dev-viewer`). */
export const FAKE_VIEWER = { username: 'dev-viewer' } as const;

export function createAppFakeStorage(
  options: Partial<Omit<FakeStorageOptions, 'manifest'>> = {},
): FakeStorage {
  return createFakeStorage({ manifest: committedManifest(), viewer: FAKE_VIEWER, ...options });
}

/**
 * Plant legacy-shaped rows exactly as the cutover copy script lays them down:
 * collection `kv`, the legacy key verbatim, data `{ value: <legacy value> }`.
 */
export async function seedKv(fake: FakeStorage, rows: Record<string, unknown>): Promise<void> {
  const kv = fake.storage.collection<KvDocument>(KV_COLLECTION);
  for (const [key, value] of Object.entries(rows)) {
    await kv.put(key, { value });
  }
}
