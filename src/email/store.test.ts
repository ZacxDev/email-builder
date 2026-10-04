// store.ts — draft persistence over a fake UseAppStorage: key scheme,
// newest-first listing, junk-row dropping, and error classification.

import { describe, expect, it, vi } from 'vitest';
import type { UseAppStorage } from '@civitai/blocks-react';

import { newDraft } from './email.js';
import { EmailStore, classifyStoreError, draftKey } from './store.js';

function fakeStorage(rows: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(rows));
  const storage = {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    list: vi.fn(async () => ({
      keys: [...data.keys()].map((key) => ({ key })),
      nextCursor: undefined,
    })),
    getQuota: vi.fn(async () => ({ usedBytes: 0, maxBytes: 100, usedRows: 0, maxRows: 10 })),
  };
  return { storage: storage as unknown as UseAppStorage, data };
}

describe('EmailStore', () => {
  it('saves under the draft: prefix and lists newest-first, dropping junk', async () => {
    const { storage, data } = fakeStorage({ 'draft:broken': { nope: true }, other: 1 });
    const store = new EmailStore(storage);
    const older = { ...newDraft('d1', '2026-10-01T00:00:00Z'), name: 'Older' };
    const newer = { ...newDraft('d2', '2026-10-03T00:00:00Z'), name: 'Newer' };
    await store.saveDraft(older);
    await store.saveDraft(newer);
    expect(data.has(draftKey('d1'))).toBe(true);
    const list = await store.listDrafts();
    expect(list.map((d) => d.id)).toEqual(['d2', 'd1']);
    await store.deleteDraft('d1');
    expect((await store.listDrafts()).map((d) => d.id)).toEqual(['d2']);
  });

  it('classifies the scope-denied shape as not-permitted', () => {
    expect(
      classifyStoreError(new Error('storage set requires the apps:storage:write scope')),
    ).toBe('not-permitted');
    expect(classifyStoreError(new Error('whatever'))).toBe('unknown');
  });
});
