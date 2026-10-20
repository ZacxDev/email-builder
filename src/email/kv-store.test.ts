// The private `kv` mapping is a contract with the cutover copy script
// (`copy-kv-to-appdata.sql`): collection `kv`, key = the legacy key verbatim,
// data = `{ value: <legacy value> }`. These cases pin all three with LITERALS,
// against the SDK's own fake store built from the COMMITTED manifest — so an
// undeclared or renamed collection fails here as `collection_not_declared`
// rather than passing against a phantom store.

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { newDraft } from './email.js';
import { createAppFakeStorage } from './fake-doc-storage.js';
import { KV_COLLECTION, KV_LIST_LIMIT_MAX, createKvStorage, type KvDocument } from './kv-store.js';
import { DRAFT_PREFIX, EmailStore, draftKey } from './store.js';

const kvOf = (fake: ReturnType<typeof createAppFakeStorage>) =>
  fake.storage.collection<KvDocument>('kv');

describe('the copy-script contract', () => {
  it('names the collection and the legacy key scheme literally', () => {
    expect(KV_COLLECTION).toBe('kv');
    // The legacy key the production rows sit under; renaming it strands them.
    expect(DRAFT_PREFIX).toBe('draft:');
    expect(draftKey('d-abc-1')).toBe('draft:d-abc-1');
    expect(KV_LIST_LIMIT_MAX).toBe(100);
  });

  it('the committed manifest declares `kv` private, with no indexes, and only the document-store scope', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../block.manifest.json', import.meta.url), 'utf8'),
    ) as { scopes: string[]; storage?: { collections?: Record<string, unknown> } };
    expect(manifest.storage?.collections?.kv).toEqual({ visibility: 'private' });
    expect(manifest.scopes).toContain('apps:storage');
    for (const legacy of ['apps:storage:read', 'apps:storage:write', 'apps:storage:shared:read', 'apps:storage:shared:write']) {
      expect(manifest.scopes).not.toContain(legacy);
    }
  });

  it('reads a draft exactly as the copy script lays it down', async () => {
    const fake = createAppFakeStorage();
    const draft = { ...newDraft('d-legacy', '2026-10-07T15:00:00.000Z'), name: 'Spring launch' };
    await kvOf(fake).put('draft:d-legacy', { value: draft });

    const kv = createKvStorage(() => fake.storage);
    expect(await kv.get('draft:d-legacy')).toEqual(draft);
    // …and through the app's own store, so a key-scheme drift fails too.
    expect((await new EmailStore(kv).listDrafts()).map((d) => d.name)).toEqual(['Spring launch']);
  });

  it('writes the wrapped shape under the legacy key, so a copy re-run and the app agree', async () => {
    const fake = createAppFakeStorage();
    const kv = createKvStorage(() => fake.storage);
    await kv.set('draft:d-9', { id: 'd-9', name: 'x' });

    expect((await kvOf(fake).get('draft:d-9'))?.data).toEqual({ value: { id: 'd-9', name: 'x' } });
    const put = fake.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('blocks/storage/kv/draft%3Ad-9');
    expect(put?.body).toEqual({ data: { value: { id: 'd-9', name: 'x' } } });
  });

  it('lists whole documents under a prefix, unwrapped, clamped to the server max', async () => {
    const fake = createAppFakeStorage();
    const kv = createKvStorage(() => fake.storage);
    await kv.set('draft:a', { id: 'a' });
    await kv.set('draft:b', { id: 'b' });
    await kv.set('other', { id: 'z' });

    const page = await kv.list({ prefix: 'draft:', limit: 500 });
    expect(page.entries.map((e) => [e.key, e.value])).toEqual([
      ['draft:a', { id: 'a' }],
      ['draft:b', { id: 'b' }],
    ]);
    const list = fake.calls.find((c) => c.method === 'GET' && c.query.keyPrefix === 'draft:');
    expect(list?.query.limit).toBe('100');

    expect(await kv.delete('draft:a')).toEqual({ ok: true, deleted: true });
    expect(await kv.get('draft:a')).toBeNull();
  });

  it('is private: one viewer never reads another viewer’s draft', async () => {
    const fake = createAppFakeStorage();
    await createKvStorage(() => fake.storage).set('draft:a', { id: 'a' });
    const bob = createKvStorage(() => fake.as({ viewer: { username: 'bob' } }).storage);
    expect(await bob.get('draft:a')).toBeNull();
  });

  it('REJECTS an anonymous viewer rather than reporting "nothing stored"', async () => {
    const kv = createKvStorage(() => createAppFakeStorage({ viewer: null }).storage);
    await expect(kv.get('draft:a')).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(kv.set('draft:a', {})).rejects.toMatchObject({ code: 'sign_in_required' });
  });
});
