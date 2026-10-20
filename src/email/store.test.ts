// store.ts — draft persistence over the REAL document-store client
// (`createKvStorage` on the SDK's `createFakeStorage`, which enforces the
// committed manifest and the server's rules): key scheme, newest-first
// listing, junk-row dropping, and error classification.

import { describe, expect, it } from 'vitest';

import { StorageError } from '@civitai/sdk';
import { createFakeStorage, type FakeStorage } from '@civitai/sdk/testing';

import { newDraft } from './email.js';
import { createAppFakeStorage, seedKv } from './fake-doc-storage.js';
import { KV_COLLECTION, createKvStorage, type KvDocument } from './kv-store.js';
import { EmailStore, classifyStoreError, draftKey } from './store.js';

function makeStore(fake: FakeStorage = createAppFakeStorage()) {
  return { fake, store: new EmailStore(createKvStorage(() => fake.storage)) };
}

describe('EmailStore', () => {
  it('saves under the draft: prefix and lists newest-first, dropping junk', async () => {
    const { fake, store } = makeStore();
    await seedKv(fake, { 'draft:broken': { nope: true }, other: 1 });
    const older = { ...newDraft('d1', '2026-10-01T00:00:00Z'), name: 'Older' };
    const newer = { ...newDraft('d2', '2026-10-03T00:00:00Z'), name: 'Newer' };
    await store.saveDraft(older);
    await store.saveDraft(newer);
    const raw = await fake.storage.collection<KvDocument>(KV_COLLECTION).get(draftKey('d1'));
    expect(raw?.data).toEqual({ value: older });
    const list = await store.listDrafts();
    expect(list.map((d) => d.id)).toEqual(['d2', 'd1']);
    await store.deleteDraft('d1');
    expect((await store.listDrafts()).map((d) => d.id)).toEqual(['d2']);
  });

  it('pages through more than one list page, with no per-key reads', async () => {
    const { fake, store } = makeStore();
    for (let i = 0; i < 130; i++) {
      await store.saveDraft({ ...newDraft(`d${i}`, `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}Z`) });
    }
    const before = fake.calls.length;
    const list = await store.listDrafts();
    expect(list).toHaveLength(130);
    const reads = fake.calls.slice(before);
    expect(reads).toHaveLength(2);
    expect(reads.every((c) => c.method === 'GET' && c.query.keyPrefix === 'draft:')).toBe(true);
  });
});

describe('classifyStoreError', () => {
  const refusal = (code: string, status = 400) => new StorageError(status, code, code, { code });

  it('maps document-store codes onto the closed set', () => {
    expect(classifyStoreError(refusal('too_large', 413))).toBe('value-too-large');
    expect(classifyStoreError(refusal('quota_exceeded', 413))).toBe('quota-exceeded');
    expect(classifyStoreError(refusal('insufficient_scope', 403))).toBe('not-permitted');
    expect(classifyStoreError(refusal('collection_not_declared', 404))).toBe('not-permitted');
    expect(classifyStoreError(refusal('rate_limited', 429))).toBe('request-failed');
    expect(classifyStoreError(new TypeError('Failed to fetch'))).toBe('request-failed');
    expect(classifyStoreError(refusal('sign_in_required', 401))).toBe('unknown');
    expect(classifyStoreError(new Error('whatever'))).toBe('unknown');
  });

  it('classifies the REAL refusals the store sends', async () => {
    const full = makeStore(createAppFakeStorage({ limits: { viewerDocs: 1 } }));
    await full.store.saveDraft(newDraft('a', '2026-10-01T00:00:00Z'));
    const over = await full.store.saveDraft(newDraft('b', '2026-10-01T00:00:00Z')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(classifyStoreError(over)).toBe('quota-exceeded');

    const big = makeStore();
    const tooBig = await big.store
      .saveDraft({ ...newDraft('c', '2026-10-01T00:00:00Z'), name: 'x'.repeat(70_000) })
      .then(() => null, (e: unknown) => e);
    expect(classifyStoreError(tooBig)).toBe('value-too-large');

    const undeclared = makeStore(
      createFakeStorage({ manifest: { scopes: ['apps:storage'], storage: { collections: {} } } }),
    );
    const notDeclared = await undeclared.store.listDrafts().then(() => null, (e: unknown) => e);
    expect(classifyStoreError(notDeclared)).toBe('not-permitted');
  });
});
