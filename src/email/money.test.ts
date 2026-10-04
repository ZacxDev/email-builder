// money.ts — the priced-step driver: submit once, poll to terminal, never
// mistake a transport blip for a workflow failure.

import { describe, expect, it, vi } from 'vitest';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import { runToTerminal } from './money.js';

const snap = (status: BlockWorkflowSnapshot['status'], over: Partial<BlockWorkflowSnapshot> = {}) =>
  ({ workflowId: 'wf-1', status, ...over }) as BlockWorkflowSnapshot;

const BODY: WorkflowBody = {
  kind: 'step',
  step: 'chat-completion',
  params: { model: 'openai/gpt-4o-mini', maxTokens: 100, messages: [] },
};

describe('runToTerminal', () => {
  it('resolves immediately when submit returns a terminal snapshot', async () => {
    const submit = vi.fn(async () => snap('succeeded', { cost: { total: 3 } }));
    const poll = vi.fn(async () => snap('succeeded'));
    const out = await runToTerminal(submit, poll, BODY, 'k-1');
    expect(out.status).toBe('succeeded');
    expect(out.cost?.total).toBe(3);
    expect(poll).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(BODY, { idempotencyKey: 'k-1' });
  });

  it('passes a priced refusal (terminal failed snapshot) through as a resolution', async () => {
    const submit = vi.fn(async () => snap('failed', { cost: { total: 9 }, error: 'insufficient' }));
    const out = await runToTerminal(submit, vi.fn(async () => snap('succeeded')), BODY, 'k-1');
    expect(out.status).toBe('failed');
    expect(out.cost?.total).toBe(9);
  });

  it('polls a processing workflow to terminal', async () => {
    vi.useFakeTimers();
    try {
      const submit = vi.fn(async () => snap('processing'));
      const poll = vi
        .fn<() => Promise<BlockWorkflowSnapshot>>()
        .mockResolvedValueOnce(snap('processing'))
        .mockResolvedValueOnce(snap('succeeded', { imageUrls: ['https://img/1.png'] }));
      const promise = runToTerminal(submit, poll, BODY, 'k-1');
      await vi.runAllTimersAsync();
      const out = await promise;
      expect(out.status).toBe('succeeded');
      expect(out.imageUrls).toEqual(['https://img/1.png']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transient poll throw is retried, not failed', async () => {
    vi.useFakeTimers();
    try {
      const submit = vi.fn(async () => snap('processing'));
      const poll = vi
        .fn<() => Promise<BlockWorkflowSnapshot>>()
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce(snap('succeeded'));
      const promise = runToTerminal(submit, poll, BODY, 'k-1');
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toMatchObject({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects only when the backend stays unreachable', async () => {
    vi.useFakeTimers();
    try {
      const submit = vi.fn(async () => snap('processing'));
      const poll = vi.fn(async () => {
        throw new Error('down');
      });
      const promise = runToTerminal(submit, poll, BODY, 'k-1');
      const assertion = expect(promise).rejects.toThrow('unreachable');
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a submit throw rejects (nothing was queued)', async () => {
    const submit = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(runToTerminal(submit, vi.fn(), BODY, 'k-1')).rejects.toThrow('nope');
  });
});
