// 0.2.0 — drafts moved from the legacy per-viewer KV (`useAppStorage`, bridge
// messages APP_STORAGE_*) to the document store's private `kv` collection.
// These drive the REAL <App/> against the mock host for the bridge and the
// SDK's `createFakeStorage` for the document store (installed per test by
// ./test-setup.ts), and pin:
//   1. a viewer's drafts as the cutover copy laid them down render;
//   2. a delete reaches `kv` under the legacy key (the `{ value }` write shape
//      is pinned in ./email/kv-store.test.ts);
//   3. an anonymous viewer sends the store nothing;
//   4. in production wiring (no override) the requests go to the HOST origin's
//      `/api/v1/blocks/storage/kv`, with the block token.
// test-setup's tripwire additionally fails ANY test that speaks the legacy
// store, so the pre-port app cannot pass these by answering from the mock host.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from './App.js';
import { SCREENSHOT_SEED } from './dev-screenshot-seed.js';
import { configureDocumentStorage } from './email/doc-storage.js';
import { seedKv } from './email/fake-doc-storage.js';
import { KV_COLLECTION, type KvDocument } from './email/kv-store.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

const VIEWER = { id: 2, username: 'dev', status: 'active' } as const;

describe('drafts on the document store (0.2.0)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('renders drafts exactly as the copy script wrote them (kv, legacy key, { value })', async () => {
    const user = userEvent.setup();
    await seedKv(testDocStore(), SCREENSHOT_SEED);
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);
    await user.click(await screen.findByTestId('eb-drafts-open', {}, { timeout: 5000 }));
    expect(
      await within(screen.getByTestId('eb-drawer-drafts')).findByText(/Spring launch announcement/),
    ).toBeInTheDocument();
    const lists = testDocStore().calls.filter((c) => c.method === 'GET' && c.path === `blocks/storage/${KV_COLLECTION}`);
    expect(lists.map((c) => c.query.keyPrefix)).toEqual(['draft:']);
  });

  it('a delete removes the `kv` document under the legacy key', async () => {
    const user = userEvent.setup();
    await seedKv(testDocStore(), SCREENSHOT_SEED);
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);
    await user.click(await screen.findByTestId('eb-drafts-open', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('eb-draft-menu-demo-1'));
    await user.click(screen.getByTestId('eb-delete-demo-1'));
    await user.click(screen.getByTestId('eb-delete-demo-1'));

    const kv = testDocStore().storage.collection<KvDocument>(KV_COLLECTION);
    await waitFor(async () => expect(await kv.get('draft:demo-1')).toBeNull());
    const del = testDocStore().calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toBe(`blocks/storage/${KV_COLLECTION}/draft%3Ademo-1`);
  });

  it('an anonymous viewer never reaches the store (private reads refuse them)', async () => {
    uninstall = installMockMoneyHost({ viewer: null, consentGranted: false });
    render(<App />);
    await screen.findByTestId('eb-app');
    await new Promise((r) => setTimeout(r, 50));
    expect(testDocStore().calls).toEqual([]);
  });

  it('production wiring: the HOST origin’s /api/v1/blocks/storage/kv, with the block token', async () => {
    configureDocumentStorage(null);
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);
    await waitFor(() => expect(seen.some((s) => s.url.includes('/blocks/storage/kv'))).toBe(true));
    for (const call of seen.filter((s) => s.url.includes('/blocks/storage'))) {
      expect(call.url.startsWith(`${window.location.origin}/api/v1/blocks/storage/kv`)).toBe(true);
      expect(call.auth).toMatch(/^Bearer \S+/);
    }
  });
});
