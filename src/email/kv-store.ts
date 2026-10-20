/**
 * Email Builder — the viewer's key/value records, over ONE private
 * collection of the App Blocks document store.
 *
 * Until 0.2.0 the drafts lived in the legacy per-viewer KV (`useAppStorage`
 * from `@civitai/blocks-react`, routes `/api/v1/blocks/app-storage/*`, scopes
 * `apps:storage:read` + `apps:storage:write`). That store is deprecated; the
 * document store (`app.storage.collection(name)` from `@civitai/sdk`, scope
 * `apps:storage`) replaces it. This module is the whole port for the data
 * shape: `./store.ts` keeps the get/set/delete/list surface it was written
 * against and only this file knows documents exist.
 *
 * 🔴 THE MAPPING IS FIXED, AND SOMETHING OUTSIDE THIS REPO DEPENDS ON IT EXACTLY.
 * Existing viewers' rows are copied from the legacy KV into the document store
 * by a separate, hand-run script at cutover (the same one the other first-party
 * apps used). That script writes what this module reads, so changing any of
 * the three rules below strands every copied record:
 *
 *   1. ONE collection, named `kv`, declared `private` in `block.manifest.json`
 *      (and with NO `indexes` — the copy writes no index rows).
 *   2. Document key = the legacy KV key, byte-for-byte (`draft:<id>` — see
 *      `DRAFT_PREFIX` in `./store.ts`).
 *   3. Document data = `{ value: <the legacy value> }` — ALWAYS wrapped, for
 *      every key. The copy script wraps every value without looking at it, so
 *      this module unwraps every value the same way. One rule, no branch.
 *
 * `./kv-store.test.ts` pins all three with literal values against
 * `createFakeStorage` (the SDK's own client over an in-memory server that
 * enforces the COMMITTED manifest).
 */

import type { DocumentStorage, StorageCollection } from '@civitai/sdk';

/** The one private collection. Must match `block.manifest.json` → `storage.collections`. */
export const KV_COLLECTION = 'kv';

/**
 * The largest page `list` may ask for. A larger `limit` is REFUSED
 * (`invalid_request`), not clamped, by the document store — so clamp here.
 */
export const KV_LIST_LIMIT_MAX = 100;

/** The stored document's data. See rule 3 above. */
export interface KvDocument {
  value: unknown;
}

/** One listed record: the key AND its unwrapped value (a list returns whole documents). */
export interface KvEntry {
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface KvListResult {
  entries: KvEntry[];
  /** Absent exactly when this was the last page. */
  nextCursor?: string;
}

/** The key/value surface `EmailStore` consumes. */
export interface KvStorage {
  /** The stored value, or `null` when the key has never been written (or was deleted). */
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  /** ONE page of records under `prefix`. Follow `nextCursor` for the next. */
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<KvListResult>;
}

/**
 * Build the KV surface over a document store.
 *
 * Every failure REJECTS with the store's `StorageError` (an anonymous viewer is
 * `sign_in_required`, a version whose manifest is not approved yet is
 * `collection_not_declared`, a quota or rate limit…). Nothing here turns a
 * refusal into "nothing stored"; `./store.ts` classifies it.
 *
 * `docs` is called per operation rather than once, so the production caller can
 * hand in "await the client" and this façade is a plain object that exists
 * before the client does.
 */
export function createKvStorage(
  docs: () => DocumentStorage | Promise<DocumentStorage>,
): KvStorage {
  const kv = async (): Promise<StorageCollection<KvDocument>> =>
    (await docs()).collection<KvDocument>(KV_COLLECTION);

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await (await kv()).get(key);
      // Missing → `null`, which is what the legacy `get` answered for a key
      // never written. Data without `value` reads as missing too.
      return (doc?.data.value ?? null) as T | null;
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true }> {
      await (await kv()).put(key, { value });
      return { ok: true };
    },
    async delete(key: string): Promise<{ ok: true; deleted: boolean }> {
      const { deleted } = await (await kv()).delete(key);
      return { ok: true, deleted };
    },
    async list(opts = {}): Promise<KvListResult> {
      const limit = Math.min(Math.max(1, opts.limit ?? KV_LIST_LIMIT_MAX), KV_LIST_LIMIT_MAX);
      const page = await (await kv()).list({
        ...(opts.prefix !== undefined ? { keyPrefix: opts.prefix } : {}),
        limit,
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      });
      return {
        entries: page.items.map((doc) => ({
          key: doc.key,
          value: doc.data.value ?? null,
          updatedAt: doc.updatedAt,
        })),
        ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}
