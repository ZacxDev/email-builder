/**
 * Email Builder — durable draft store on the document store's private `kv`
 * collection (`./kv-store.ts`).
 *
 * One key space and one budget per (app, viewer): a document is capped at
 * 64 KiB and a viewer at `info().limits.viewerDocs` documents. A draft (brief +
 * subjects + 3 variants + banner pointers) is a few KiB, so one document per
 * draft is right. Malformed rows are dropped by the normalizer, never thrown.
 * Storage failures surface as `StoreErrorKind` — the UI renders its own copy.
 */

import { StorageError } from '@civitai/sdk';

import { normalizeDraft, type EmailDraft } from './email.js';
import type { KvStorage } from './kv-store.js';

/**
 * 🔴 The legacy KV key prefix, verbatim: the cutover copy script carries every
 * legacy key over unchanged, so renaming this strands every copied draft.
 */
export const DRAFT_PREFIX = 'draft:';

export function draftKey(id: string): string {
  return `${DRAFT_PREFIX}${id}`;
}

export type StoreErrorKind =
  | 'value-too-large'
  | 'quota-exceeded'
  | 'row-limit'
  | 'request-failed'
  | 'not-permitted'
  | 'unknown';

/**
 * Map a document-store refusal onto the closed set the UI branches on —
 * by the envelope's `code`, never its prose. `row-limit` is no longer
 * produced (one `quota_exceeded` covers both per-viewer ceilings); it stays in
 * the union because the copy table is keyed on it.
 */
export function classifyStoreError(error: unknown): StoreErrorKind {
  if (error instanceof StorageError) {
    switch (error.code) {
      case 'too_large':
        return 'value-too-large';
      case 'quota_exceeded':
        return 'quota-exceeded';
      case 'insufficient_scope':
      case 'consent_required':
      case 'collection_not_declared':
      case 'not_eligible':
        return 'not-permitted';
      case 'rate_limited':
      case 'service_unavailable':
      case 'consent_unavailable':
      case 'internal_error':
        return 'request-failed';
      default:
        return 'unknown';
    }
  }
  // `fetch` itself rejected (offline, connection dropped).
  if (error instanceof TypeError) return 'request-failed';
  return 'unknown';
}

/** Viewer-facing copy for a storage failure. Never the host's raw prose. */
export function storeErrorMessage(kind: StoreErrorKind): string {
  switch (kind) {
    case 'not-permitted':
      return "Draft saving isn't permitted in this context — your work stays on screen for this session.";
    case 'value-too-large':
    case 'quota-exceeded':
    case 'row-limit':
      return 'Draft storage is full — delete an old draft and try again.';
    case 'request-failed':
    case 'unknown':
      return "Couldn't save that draft — your work stays on screen for this session.";
  }
}

export class EmailStore {
  constructor(private readonly storage: KvStorage) {}

  async listDrafts(): Promise<EmailDraft[]> {
    const out: EmailDraft[] = [];
    let cursor: string | undefined;
    do {
      // A document-store page carries whole documents: no per-key `get`
      // fan-out (the legacy list returned keys only).
      const page = await this.storage.list({ prefix: DRAFT_PREFIX, cursor, limit: 100 });
      for (const entry of page.entries) {
        const item = normalizeDraft(entry.value);
        if (item !== null) out.push(item);
      }
      cursor = page.nextCursor;
    } while (cursor);
    // Newest first — the drafts list is a recency list.
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async saveDraft(draft: EmailDraft): Promise<void> {
    await this.storage.set(draftKey(draft.id), draft);
  }

  async deleteDraft(id: string): Promise<void> {
    await this.storage.delete(draftKey(id));
  }
}
