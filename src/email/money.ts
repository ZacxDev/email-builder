// The money driver for Email Builder's priced steps (chat-completion and the
// banner pass-through). Same discipline as the rest of the portfolio:
// estimate first, park a confirm, submit once with a stable idempotency key,
// then own the poll loop to terminal.
//
// Poll robustness contract (from the scaffold / Character Sheet Studio): a
// poll() THROW is a transport blip, NOT a workflow failure — a real failure
// arrives as a 'failed'/'expired'/'canceled' SNAPSHOT. Throws are retried
// with bounded backoff; only a long consecutive streak gives up, via
// onUnreachable, so a server-side success is never marked failed locally.
//
// No React, no DOM — unit-tested in node (see money.test.ts).

import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import { isTerminalStatus } from './email.js';

export type PollFn = (workflowId: string) => Promise<BlockWorkflowSnapshot>;
export type SubmitFn = (
  body: WorkflowBody,
  options?: { idempotencyKey?: string },
) => Promise<BlockWorkflowSnapshot>;

export interface PollLoopCallbacks {
  /** Every snapshot received (terminal stops the loop after this call). */
  onSnapshot: (snap: BlockWorkflowSnapshot) => void;
  /** The backend stayed unreachable past the transient-error budget. */
  onUnreachable: () => void;
}

export interface PollLoopOptions {
  scheduleMs?: readonly number[];
  retryMs?: readonly number[];
  maxTransientErrors?: number;
}

/** Drive one workflow to terminal. Returns a cancel function. */
export function startPollLoop(
  poll: PollFn,
  workflowId: string,
  cb: PollLoopCallbacks,
  opts: PollLoopOptions = {},
): () => void {
  const SCHEDULE_MS = opts.scheduleMs ?? [1500, 2000, 3000, 5000, 8000];
  const RETRY_MS = opts.retryMs ?? [500, 1000, 2000, 4000];
  const MAX_TRANSIENT_ERRORS = opts.maxTransientErrors ?? 8;

  const tok = { cancelled: false };
  let attempt = 0;
  let consecutiveErrors = 0;

  const tick = async () => {
    if (tok.cancelled) return;
    let snap: BlockWorkflowSnapshot;
    try {
      snap = await poll(workflowId);
    } catch {
      if (tok.cancelled) return;
      consecutiveErrors += 1;
      if (consecutiveErrors > MAX_TRANSIENT_ERRORS) {
        cb.onUnreachable();
        return;
      }
      const delay = RETRY_MS[Math.min(consecutiveErrors - 1, RETRY_MS.length - 1)]!;
      setTimeout(tick, delay);
      return;
    }
    if (tok.cancelled) return;
    consecutiveErrors = 0;
    cb.onSnapshot(snap);
    if (isTerminalStatus(snap.status)) return;
    const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)]!;
    attempt += 1;
    setTimeout(tick, delay);
  };

  const first = setTimeout(tick, 0);
  return () => {
    tok.cancelled = true;
    clearTimeout(first);
  };
}

/**
 * Submit one priced body and resolve with its TERMINAL snapshot. A submit
 * that already returns a terminal snapshot (the mock host, or a priced
 * refusal) resolves immediately; otherwise the poll loop owns the wait.
 * Rejects only when the backend stays unreachable — the caller turns that
 * into "may still be running, check back" copy, never "it failed, retry
 * and pay again".
 */
export function runToTerminal(
  submit: SubmitFn,
  poll: PollFn,
  body: WorkflowBody,
  idempotencyKey: string,
  opts: PollLoopOptions = {},
): Promise<BlockWorkflowSnapshot> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (snap: BlockWorkflowSnapshot) => {
      if (!settled) {
        settled = true;
        resolve(snap);
      }
    };
    void (async () => {
      try {
        const snap = await submit(body, { idempotencyKey });
        if (isTerminalStatus(snap.status)) {
          done(snap);
          return;
        }
        startPollLoop(
          poll,
          snap.workflowId,
          {
            onSnapshot: (s2) => {
              if (isTerminalStatus(s2.status)) done(s2);
            },
            onUnreachable: () => {
              if (!settled) {
                settled = true;
                reject(new Error('workflow unreachable'));
              }
            },
          },
          opts,
        );
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error('submit failed'));
        }
      }
    })();
  });
}
