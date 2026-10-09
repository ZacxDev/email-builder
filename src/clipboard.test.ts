import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextBounded } from './clipboard.js';

function stubClipboard(writeText: unknown) {
  vi.stubGlobal('navigator', { clipboard: writeText === undefined ? {} : { writeText } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('copyTextBounded', () => {
  it('returns true when the write settles successfully', async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    await expect(copyTextBounded('<p>hi</p>')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('<p>hi</p>');
  });

  it('returns false when the write rejects (clipboard blocked)', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    await expect(copyTextBounded('x')).resolves.toBe(false);
  });

  it('returns false when there is no clipboard API', async () => {
    stubClipboard(undefined);
    await expect(copyTextBounded('x')).resolves.toBe(false);
  });

  it('returns false instead of hanging when the write never settles', async () => {
    vi.useFakeTimers();
    stubClipboard(() => new Promise<void>(() => {}));
    const pending = copyTextBounded('x', 4000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(pending).resolves.toBe(false);
  });
});
