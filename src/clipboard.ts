/**
 * Bounded clipboard copy for the sandboxed app frame.
 *
 * In the live Civitai iframe (especially when the tab is not the visible
 * tab), `navigator.clipboard.writeText` can hang indefinitely instead of
 * resolving or rejecting — the export button then shows no outcome at
 * all. Race the write against a timeout so the caller can always land on
 * an honest fallback notice within a bounded time.
 *
 * Returns true only when the write actually settled successfully.
 */
export async function copyTextBounded(text: string, timeoutMs = 4000): Promise<boolean> {
  const write = globalThis.navigator?.clipboard?.writeText;
  if (typeof write !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('clipboard write timed out')), timeoutMs);
    });
    await Promise.race([write.call(globalThis.navigator.clipboard, text), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
