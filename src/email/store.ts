/**
 * Email Builder — durable draft store on `useAppStorage`.
 *
 * Keys are namespaced per (block instance, viewer); budgets are enforced per
 * (app, viewer): 64 KiB per value, 1000 rows. A draft (brief + subjects + 3
 * variants + banner pointers) is a few KiB, so one row per draft is right.
 * Malformed rows are dropped by the normalizer, never thrown. Storage
 * failures surface as `StoreErrorKind` — the UI renders its own copy.
 */

import { classifyAppStorageError } from '@civitai/app-sdk/blocks';
import type { UseAppStorage } from '@civitai/blocks-react';

import { normalizeDraft, type EmailDraft } from './email.js';

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

/** The host's scope-denied message shape for app storage. */
const STORAGE_SCOPE_DENIED =
  /storage (get|set|delete|list) requires the apps:storage:(read|write) scope/;

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    return typeof m === 'string' ? m : '';
  }
  return '';
}

/** Map a storage failure onto the closed set the UI branches on. */
export function classifyStoreError(error: unknown): StoreErrorKind {
  if (STORAGE_SCOPE_DENIED.test(errorMessage(error))) return 'not-permitted';
  switch (classifyAppStorageError(error)) {
    case 'value-too-large':
      return 'value-too-large';
    case 'user-quota-exceeded':
    case 'app-quota-exceeded':
      return 'quota-exceeded';
    case 'user-row-limit':
    case 'app-row-limit':
      return 'row-limit';
    case 'request-failed':
      return 'request-failed';
    default:
      return 'unknown';
  }
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
  constructor(private readonly storage: UseAppStorage) {}

  async listDrafts(): Promise<EmailDraft[]> {
    const out: EmailDraft[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.storage.list({ prefix: DRAFT_PREFIX, cursor, limit: 100 });
      const values = await Promise.all(page.keys.map((entry) => this.storage.get(entry.key)));
      for (const value of values) {
        const item = normalizeDraft(value);
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
