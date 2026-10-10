// copy-status.test.tsx — v0.1.16 regression: the Copy HTML outcome is
// durable. In the live sandboxed frame the clipboard write is rejected,
// and the generic notice/flash could be retired by an unrelated autosave
// completing (live walks 2328/2118 showed "Copy HTML" with no outcome).
// The export-owned eb-copy-status element must survive that autosave.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { installMockMoneyHost } from './mock-buzz.js';

const BRIEF = {
  purpose: 'Announce the v2.0 release of our photo app',
  audience: 'existing free users',
  tone: 'excited but not cringe',
  ctaText: 'Try v2 free',
  ctaUrl: 'https://example.com/v2',
  keyPoints: ['AI background removal', '2x faster exports'],
  senderName: 'The PhotoApp team',
  bannerVibe: 'bright studio photo of a phone showing a before/after edit',
};

const INTERVIEW_READY = JSON.stringify({
  reply: 'Here is your brief: a v2.0 launch email for existing free users. Look right?',
  ready: true,
  brief: BRIEF,
});

const BUNDLE = JSON.stringify({
  subjects: ['V2 is here', 'Your photos, upgraded', 'Spring launch inside'],
  preheader: 'Background removal + faster exports',
  variants: [
    {
      id: 'variant-1',
      name: 'Announcement',
      headline: 'PhotoApp v2.0 is live',
      body: ['AI background removal is here.', 'Exports are twice as fast.'],
      ctaText: 'Try v2 free',
      bannerPrompt: 'bright studio banner of a phone edit, no text',
    },
  ],
});

describe('Copy HTML outcome durability (v0.1.16)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.unstubAllGlobals();
  });

  it('a blocked copy outcome survives a later autosave', async () => {
    const user = userEvent.setup();
    // Live-frame shape: the Async Clipboard write is rejected.
    vi.stubGlobal('navigator', {
      ...window.navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE],
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));
    expect(
      await screen.findByText(/Here is your brief/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    await user.click(await screen.findByTestId('eb-generate-bundle', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('eb-confirm-run'));

    // The package exists; copy it. The clipboard rejects, so the outcome
    // must be the blocked copy status (not silence).
    await user.click(await screen.findByTestId('eb-copy-html', {}, { timeout: 8000 }));
    expect(await screen.findByTestId('eb-copy-status')).toHaveTextContent(/copy blocked/i);

    // Now make a manual edit (schedules an autosave ~900ms out) and wait
    // for the save to settle. Before v0.1.16, that save's completion wiped
    // the copy outcome; the durable status must still be there after.
    await user.click(screen.getByTestId('eb-edit-toggle'));
    const headline = screen.getByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'Edited headline for the autosave race');
    expect(
      await screen.findByTestId('eb-saved-status', {}, { timeout: 8000 }),
    ).toHaveTextContent(/saved/i);
    // Give any pending state cleanup a beat, then re-read.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByTestId('eb-copy-status')).toHaveTextContent(/copy blocked/i);
  }, 25000);
});
