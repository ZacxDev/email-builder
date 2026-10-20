/**
 * Email Builder — React binding for the draft store.
 *
 * Hydrates drafts once, then keeps in-memory state as the source of truth
 * with best-effort persistence: savers update state immediately and return
 * a `StoreErrorKind` (`null` on success) so the UI can be honest when a
 * save didn't land.
 *
 * The store is the document store's private `kv` collection, which REFUSES an
 * anonymous viewer (`sign_in_required`). So nothing is read until the host has
 * said who the viewer is, and an anonymous viewer is never sent to the store:
 * their drafts live in memory for the session, and a save answers 'unknown' —
 * the kind the legacy store's anonymous-write rejection classified to —
 * without a request.
 */

import { useBlockContext } from '@civitai/blocks-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useDocumentStorage } from './doc-storage.js';
import type { EmailDraft } from './email.js';
import { createKvStorage } from './kv-store.js';
import { EmailStore, classifyStoreError, type StoreErrorKind } from './store.js';

export interface EmailDrafts {
  /** False until the first hydration attempt has settled. */
  ready: boolean;
  drafts: EmailDraft[];
  saveDraft: (draft: EmailDraft) => Promise<StoreErrorKind | null>;
  deleteDraft: (id: string) => Promise<StoreErrorKind | null>;
  /** Rename in place (blank names are refused locally). */
  renameDraft: (id: string, name: string) => Promise<StoreErrorKind | null>;
  /** Copy a draft under a fresh id ("<name> copy"); resolves with the copy. */
  duplicateDraft: (
    source: EmailDraft,
  ) => Promise<{ copy: EmailDraft; error: StoreErrorKind | null }>;
}

export function useEmailDrafts(): EmailDrafts {
  const { ready: hostReady, viewer } = useBlockContext();
  const signedIn = hostReady && viewer !== null;
  const docs = useDocumentStorage();
  // `null` while the viewer is anonymous (or not known yet), or while the host
  // origin / token have not arrived: nothing can reach the store then.
  const store = useMemo(
    () => (signedIn && docs ? new EmailStore(createKvStorage(docs)) : null),
    [signedIn, docs],
  );

  const [ready, setReady] = useState(false);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);

  // Hydrate once. A storage failure just means session-only drafts.
  // No "already ran" ref guard: StrictMode double-invokes effects in dev
  // (mount -> cleanup -> mount), and a guard would leave the second, real
  // run blocked while the first sits cancelled. The cancelled flag alone
  // is the correct guard.
  useEffect(() => {
    if (!hostReady) return;
    if (store === null) {
      // Anonymous: in-memory only. (Signed in but no origin/token yet: wait —
      // the effect re-runs when the store appears.)
      if (!signedIn) setReady(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await store.listDrafts();
        if (!cancelled) setDrafts(list);
      } catch {
        // Storage unavailable — in-memory state is the source of truth.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store, hostReady, signedIn]);

  const saveDraft = useCallback(
    async (draft: EmailDraft): Promise<StoreErrorKind | null> => {
      setDrafts((prev) => {
        const rest = prev.filter((d) => d.id !== draft.id);
        return [draft, ...rest].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      });
      if (store === null) return 'unknown';
      try {
        await store.saveDraft(draft);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const deleteDraft = useCallback(
    async (id: string): Promise<StoreErrorKind | null> => {
      setDrafts((prev) => prev.filter((d) => d.id !== id));
      if (store === null) return 'unknown';
      try {
        await store.deleteDraft(id);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [store],
  );

  const renameDraft = useCallback(
    async (id: string, name: string): Promise<StoreErrorKind | null> => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const current = drafts.find((d) => d.id === id);
      if (!current || current.name === trimmed) return null;
      const renamed = { ...current, name: trimmed, updatedAt: new Date().toISOString() };
      setDrafts((prev) =>
        prev
          .map((d) => (d.id === id ? renamed : d))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      );
      if (store === null) return 'unknown';
      try {
        await store.saveDraft(renamed);
        return null;
      } catch (err) {
        return classifyStoreError(err);
      }
    },
    [drafts, store],
  );

  const duplicateDraft = useCallback(
    async (source: EmailDraft): Promise<{ copy: EmailDraft; error: StoreErrorKind | null }> => {
      const id = `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const copy: EmailDraft = {
        ...source,
        id,
        name: `${source.name} copy`,
        updatedAt: new Date().toISOString(),
      };
      const error = await saveDraft(copy);
      return { copy, error };
    },
    [saveDraft],
  );

  return { ready, drafts, saveDraft, deleteDraft, renameDraft, duplicateDraft };
}
