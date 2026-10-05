// builder.test.tsx — Email Builder P1 end-to-end proof in the mock host.
//
// Drives the FULL flow through the real SDK transport (no hook mocking):
//   interview turn (chat-completion, canned via stepTextOutputs)
//     -> brief ready -> priced confirm -> bundle (subjects + 3 variants)
//     -> banner (pass-through imageGen) -> "up to" confirm -> banner in preview
//     -> chat refinement revises the selected variant
//     -> manual tweak edits the preview live
// Plus the two gates: anon sees sign-in; a missing budgeted scope parks the
// action behind consent and auto-resumes on the grant.

import { StrictMode } from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { SCREENSHOT_SEED } from './dev-screenshot-seed.js';
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
    {
      id: 'variant-2',
      name: 'Minimal',
      headline: 'Less editing. More photo.',
      body: ['Two features. Zero learning curve.'],
      ctaText: 'Try v2 free',
      bannerPrompt: 'minimal gradient banner, no text',
    },
    {
      id: 'variant-3',
      name: 'Story',
      headline: 'Maya shot this on her phone',
      body: ['She removed the background in one tap.'],
      ctaText: 'Try v2 free',
      bannerPrompt: 'warm lifestyle banner, no text',
    },
  ],
});

const REFINED = JSON.stringify({
  headline: 'V2 is live — shorter, punchier',
  body: ['One tap removes any background.'],
  ctaText: 'Try v2 free',
  bannerPrompt: 'bright studio banner of a phone edit, no text',
});

const VIEWER = { id: 2, username: 'dev', status: 'active' } as const;

describe('Email Builder (P1 e2e, mock host)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  /** Interview (1 canned turn, brief ready) -> bundle. Lands on variants. */
  async function driveToBundle(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByTestId('eb-send');
    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'I want to announce our v2 launch to free users',
    );
    await user.click(screen.getByTestId('eb-send'));
    // v0.1.4: chat sends immediately — no priced confirm for chat turns.
    expect(screen.queryByTestId('eb-confirm')).not.toBeInTheDocument();
    // The canned assistant reply lands and the brief fills in.
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-brief')).toHaveTextContent('Announce the v2.0 release');
    expect(screen.getByTestId('eb-generate-bundle')).toBeEnabled();

    await user.click(screen.getByTestId('eb-generate-bundle'));
    expect(await screen.findByTestId('eb-confirm')).toHaveTextContent(/email package/);
    await user.click(screen.getByTestId('eb-confirm-run'));
    expect(
      await screen.findByTestId('eb-variant-variant-1', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('PhotoApp v2.0 is live');
  }

  it('interview -> bundle -> banner -> refine -> manual tweak', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE, REFINED],
    });
    render(<App />);

    await driveToBundle(user);

    // Subjects + drafts: the package auto-saved under the brief's purpose.
    expect(screen.getByTestId('eb-subject-0')).toHaveTextContent('V2 is here');
    expect(screen.getByTestId('eb-drafts')).toHaveTextContent('Announce the v2.0 release');
    expect(screen.getByTestId('eb-drafts')).toHaveTextContent('3 variants');

    // Banner: pass-through estimate is a cap, so the confirm says "up to".
    await user.click(screen.getByTestId('eb-banner-generate'));
    expect(await screen.findByTestId('eb-confirm')).toHaveTextContent(/up to/);
    await user.click(screen.getByTestId('eb-confirm-run'));
    expect(
      await screen.findByTestId('eb-banner-img', {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Chat refinement revises the selected variant immediately (no confirm).
    await user.type(screen.getByTestId('eb-chat-input'), 'make it shorter and punchier');
    await user.click(screen.getByTestId('eb-send'));
    expect(
      await screen.findByText('V2 is live — shorter, punchier', {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Manual tweak: editing the headline updates the live preview immediately.
    const headline = screen.getByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'Edited by hand');
    expect(within(screen.getByTestId('eb-preview')).getByText('Edited by hand')).toBeInTheDocument();
  });

  it('missing budgeted scope -> consent parks the chat send, grant auto-resumes and sends', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: false,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY],
    });
    render(<App />);

    await screen.findByTestId('eb-send');
    await user.type(screen.getByTestId('eb-chat-input'), 'launch email please');
    await user.click(screen.getByTestId('eb-send'));

    // Consent is requested first; after the host grant + token refresh the
    // parked send resumes on its own and the reply lands (no confirm, v0.1.4).
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('eb-confirm')).not.toBeInTheDocument();
  });

  it('anon viewer -> sign-in affordance, and Send asks for sign-in instead of spending', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({ viewer: null, consentGranted: false });
    render(<App />);

    expect(await screen.findByTestId('eb-signin')).toHaveTextContent(/sign in/i);
    await user.type(screen.getByTestId('eb-chat-input'), 'hello');
    await user.click(screen.getByTestId('eb-send'));
    expect(await screen.findByTestId('eb-notice')).toHaveTextContent(/sign in/i);
    expect(screen.queryByTestId('eb-confirm')).not.toBeInTheDocument();
  });

  it('saved drafts hydrate under StrictMode (main.tsx mounts the app in StrictMode)', async () => {
    // Regression: the hydration effect once carried an "already ran" ref
    // guard, which StrictMode's dev double-invoke (mount -> cleanup ->
    // mount) turned into "hydration never lands". The cancelled flag is
    // the only guard the effect needs.
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      storage: { seed: SCREENSHOT_SEED },
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByText(/Spring launch announcement/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-drafts')).toHaveTextContent('1 variant');
  });

  it('draft library: duplicate, rename, and two-tap delete', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      storage: { seed: SCREENSHOT_SEED },
    });
    render(<App />);

    // Duplicate the seeded template -> a "<name> copy" lands in the list.
    await user.click(await screen.findByTestId('eb-duplicate-demo-1'));
    expect(
      await screen.findByText(/Spring launch announcement copy/),
    ).toBeInTheDocument();

    // Rename the original in place.
    await user.click(screen.getByTestId('eb-rename-demo-1'));
    const nameInput = screen.getByTestId('eb-rename-input');
    await user.clear(nameInput);
    await user.type(nameInput, 'Launch v2 final');
    await user.click(screen.getByTestId('eb-rename-save'));
    expect(await screen.findByText(/Launch v2 final/)).toBeInTheDocument();

    // Delete needs a second confirming tap, then the row is gone.
    await user.click(screen.getByTestId('eb-delete-demo-1'));
    expect(screen.getByTestId('eb-delete-demo-1')).toHaveTextContent(/confirm delete/i);
    await user.click(screen.getByTestId('eb-delete-demo-1'));
    await waitFor(() =>
      expect(screen.queryByText(/Launch v2 final/)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('eb-drafts')).toHaveTextContent('Spring launch announcement copy');
  });

  it('v0.1.1 feedback: save flashes success, failures say what they cost', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: ['{"not":"a usable reply"}'],
    });
    render(<App />);

    // P1.4 — the header names the draft being edited.
    expect(await screen.findByTestId('eb-current-draft')).toHaveTextContent(/editing:/i);

    // An unusable reply: the failure notice states the charge (P1.6).
    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));
    // v0.1.4: an unreadable reply offers ONE one-tap repair (chat sends have
    // no confirm card, so the extra charge gets its own yes); the junk above
    // is unrecoverable, so the two-tries line states the total cost (P1.6).
    await user.click(await screen.findByTestId('eb-repair-run', {}, { timeout: 5000 }));
    expect(
      await screen.findByText(/over 2 tries|cost 16 Buzz/, {}, { timeout: 8000 }),
    ).toBeInTheDocument();

    // P1.1 — an explicit Save produces visible success feedback and retires
    // the stale error notice.
    await user.click(screen.getByTestId('eb-save-draft'));
    expect(await screen.findByTestId('eb-flash')).toHaveTextContent(/saved/i);
    expect(screen.queryByTestId('eb-notice')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.1: broken banner URL falls back to a regenerate placeholder', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
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
      await screen.findByText(/Here is your brief/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('eb-generate-bundle'));
    await user.click(await screen.findByTestId('eb-confirm-run'));
    await screen.findByTestId('eb-banner-generate', {}, { timeout: 15000 });

    // Generate the banner, then simulate the delivered URL going stale.
    await user.click(screen.getByTestId('eb-banner-generate'));
    await user.click(await screen.findByTestId('eb-confirm-run'));
    const img = await screen.findByTestId('eb-banner-img', {}, { timeout: 5000 });
    fireEvent.error(img);
    expect(await screen.findByTestId('eb-banner-regenerate')).toBeInTheDocument();
    expect(screen.getByTestId('eb-banner-placeholder')).toHaveTextContent(/unavailable/i);
  }, 20000);


  it('v0.1.2: Coral Post is the default palette on the app root', async () => {
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);
    const root = await screen.findByTestId('eb-app');
    expect(root).toHaveAttribute('data-palette', 'coral-post');
    expect(root.style.getPropertyValue('--civitai-color-primary').trim()).toBe('#ff6b4a');
  });

  it('v0.1.3: a truncated interview reply is salvaged free — no second submit', async () => {
    const user = userEvent.setup();
    let submits = 0;
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: [
        '{"reply":"Who should receive this one?","ready":false,"brief":{"purpose":"Launch em',
      ],
      onOutbound: (msg) => {
        if ((msg as { type?: string }).type === 'SUBMIT_WORKFLOW') submits++;
      },
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Launch email for our new shampoo',
    );
    await user.click(screen.getByTestId('eb-send'));

    expect(
      await screen.findByText('Who should receive this one?', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // v0.1.4: field-level recovery is silent (no 'recovered' nag on good replies).
    expect(screen.queryByTestId('eb-flash')).not.toBeInTheDocument();
    expect(submits).toBe(1);
  }, 20000);

  it('v0.1.3: an unreadable reply gets ONE repair retry, then lands', async () => {
    const user = userEvent.setup();
    let submits = 0;
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: ['{"totally broken"', INTERVIEW_READY],
      onOutbound: (msg) => {
        if ((msg as { type?: string }).type === 'SUBMIT_WORKFLOW') submits++;
      },
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));
    // Unreadable -> the repair is offered as one tap, not auto-charged.
    await user.click(await screen.findByTestId('eb-repair-run', {}, { timeout: 5000 }));

    expect(
      await screen.findByText(/Here is your brief/i, {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(submits).toBe(2);
    expect(screen.queryByTestId('eb-notice')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.3: when the repair also fails, the notice prices both tries', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: ['{"broken"', '{"still broken"'],
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));
    await user.click(await screen.findByTestId('eb-repair-run', {}, { timeout: 5000 }));

    expect(await screen.findByText(/over 2 tries/, {}, { timeout: 8000 })).toBeInTheDocument();
  }, 20000);

  it('v0.1.4: Enter sends the chat message (no confirm, no click)', async () => {
    const user = userEvent.setup();
    let submits = 0;
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: [INTERVIEW_READY],
      onOutbound: (msg) => {
        if ((msg as { type?: string }).type === 'SUBMIT_WORKFLOW') submits++;
      },
    });
    render(<App />);

    const input = await screen.findByTestId('eb-chat-input');
    await user.type(input, 'Announce the spring launch{enter}');
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(submits).toBe(1);
    expect(screen.queryByTestId('eb-confirm')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.4: the picked LLM model is what the chat step submits', async () => {
    const user = userEvent.setup();
    const models: string[] = [];
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: [INTERVIEW_READY],
      onOutbound: (msg) => {
        const m = msg as { type?: string; payload?: { body?: { params?: { model?: string } } } };
        if (m.type === 'SUBMIT_WORKFLOW' && m.payload?.body?.params?.model) {
          models.push(m.payload.body.params.model);
        }
      },
    });
    render(<App />);

    await user.selectOptions(
      await screen.findByTestId('eb-model-select'),
      'deepseek/deepseek-chat',
    );
    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch',
    );
    await user.click(screen.getByTestId('eb-send'));
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(models).toEqual(['deepseek/deepseek-chat']);
  }, 20000);

  it('v0.1.4: an enveloped production reply parses strictly — no recovered flash', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: [
        JSON.stringify({ choices: [{ message: { content: INTERVIEW_READY } }] }),
      ],
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('eb-flash')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eb-notice')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.4: the email draft is born as an in-chat widget with variant picking', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE],
    });
    render(<App />);

    await driveToBundle(user);

    const widget = await screen.findByTestId('eb-draft-widget');
    expect(widget).toHaveTextContent('Your email draft');
    expect(widget).toHaveTextContent('V2 is here');
    // Picking Minimal in the chat switches the editor's selected variant.
    await user.click(screen.getByTestId('eb-widget-variant-variant-2'));
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('Less editing. More photo.');
  });
});
