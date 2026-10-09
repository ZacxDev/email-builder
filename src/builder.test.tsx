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
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  async function driveToBundle(
    user: ReturnType<typeof userEvent.setup>,
    opts: { expectBanner?: boolean } = {},
  ) {
    await screen.findByTestId('eb-send');
    // v0.1.7: the chat wears its name and a messenger composer.
    expect(screen.getByText('Campaign Builder Chat')).toBeInTheDocument();
    expect(screen.getByTestId('eb-send')).toHaveAttribute('aria-label', 'Send message');
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
    // v0.1.9: the one confirm also prices the banner leg (flat 104, cap 150).
    expect(screen.getByTestId('eb-confirm')).toHaveTextContent(/banner image 104/);
    await user.click(screen.getByTestId('eb-confirm-run'));
    expect(
      await screen.findByTestId('eb-variant-variant-1', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('PhotoApp v2.0 is live');

    if (opts.expectBanner !== false) {
      // v0.1.9: the banner generated WITH the package — it is simply there.
      expect(
        await screen.findByTestId('eb-banner-img', {}, { timeout: 5000 }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('eb-banner-placeholder')).not.toBeInTheDocument();
    }
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

    // Subjects + drafts: the package auto-saved under the brief's purpose;
    // on narrow layouts the library lives in the sidebar (v0.1.11).
    expect(screen.getByTestId('eb-subject-0')).toHaveTextContent('V2 is here');
    await user.click(await screen.findByTestId('eb-drafts-open'));
    const drawer = await screen.findByTestId('eb-drafts-drawer');
    expect(drawer).toHaveTextContent('Announce the v2.0 release');
    expect(drawer).toHaveTextContent('3 variants');
    await user.click(within(drawer).getByRole('button', { name: 'Close drafts' }));

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

    // Manual tweak: the editor is collapsed by default; open it, then the
    // headline edit updates the live preview immediately.
    await user.click(screen.getByTestId('eb-edit-toggle'));
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
    const user = userEvent.setup();
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

    // v0.1.11: on narrow layouts the library is the sidebar; the seeded
    // draft waits behind the ☰ Drafts button in the chat card.
    await user.click(await screen.findByTestId('eb-drafts-open', {}, { timeout: 5000 }));
    const drawer = await screen.findByTestId('eb-drafts-drawer');
    expect(
      await within(drawer).findByText(/Spring launch announcement/),
    ).toBeInTheDocument();
    expect(drawer).toHaveTextContent('1 variant');
  });

  it('draft library: duplicate, rename, and two-tap delete', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      storage: { seed: SCREENSHOT_SEED },
    });
    render(<App />);

    // Open the library (the mobile sidebar, v0.1.11), then the seeded
    // row's ⋯ menu holds Duplicate/Rename/Delete (v0.1.5).
    await user.click(await screen.findByTestId('eb-drafts-open', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('eb-draft-menu-demo-1'));
    await user.click(await screen.findByTestId('eb-duplicate-demo-1'));
    expect(
      await within(screen.getByTestId('eb-drafts-drawer')).findByText(
        /Spring launch announcement copy/,
      ),
    ).toBeInTheDocument();

    // Rename the original in place (its row swaps to the rename input).
    await user.click(screen.getByTestId('eb-rename-demo-1'));
    const nameInput = screen.getByTestId('eb-rename-input');
    await user.clear(nameInput);
    await user.type(nameInput, 'Launch v2 final');
    await user.click(screen.getByTestId('eb-rename-save'));
    expect(
      await within(screen.getByTestId('eb-drafts-drawer')).findByText(/Launch v2 final/),
    ).toBeInTheDocument();

    // Delete needs a second confirming tap, then the row is gone.
    await user.click(screen.getByTestId('eb-delete-demo-1'));
    expect(screen.getByTestId('eb-delete-demo-1')).toHaveTextContent(/confirm delete/i);
    await user.click(screen.getByTestId('eb-delete-demo-1'));
    await waitFor(() =>
      expect(screen.queryByText(/Launch v2 final/)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('eb-drafts-drawer')).toHaveTextContent('Spring launch announcement copy');
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

    // P1.1 (v0.1.13 shape) — there is no Save button anymore: auto-save
    // settles into a stable header status and retires the stale error notice.
    // It must not be the old transient banner that expired and reappeared.
    const savedStatus = await screen.findByTestId('eb-saved-status', {}, { timeout: 8000 });
    expect(savedStatus).toHaveTextContent(/saved/i);
    expect(screen.queryByTestId('eb-flash')).not.toBeInTheDocument();
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

    // v0.1.9: the banner arrives with the package — then its URL goes stale.
    const img = await screen.findByTestId('eb-banner-img', {}, { timeout: 15000 });
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

    await user.click(await screen.findByTestId('eb-model-toggle'));
    expect(screen.getByTestId('eb-model-toggle')).toHaveTextContent(/DeepSeek V4 Flash/);
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
    // v0.1.5: the widget is a summary, not a second editor — no subject
    // badges (they clipped at 390px and duplicated the Subjects card).
    expect(widget).not.toHaveTextContent('V2 is here');
    expect(widget).toHaveTextContent('Minimal');
    // Picking Minimal in the chat switches the editor's selected variant.
    await user.click(screen.getByTestId('eb-widget-variant-variant-2'));
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('Less editing. More photo.');
  });

  it('v0.1.5 declutter: brief collapses once a package exists', async () => {
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

    // The bundle's CTA has become a re-buy, and the brief is now reference:
    // collapsed to a summary line until asked for.
    expect(screen.getByTestId('eb-regenerate-package')).toHaveTextContent(/Regenerate package/);
    expect(screen.getByTestId('eb-brief')).not.toHaveTextContent('Key points');
    await user.click(screen.getByTestId('eb-brief-toggle'));
    expect(screen.getByTestId('eb-brief')).toHaveTextContent('Key points');
    expect(screen.getByTestId('eb-brief')).toHaveTextContent('AI background removal');
  }, 20000);

  it('v0.1.5 declutter: chat outcomes land in the transcript, not page-top', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      stepTextOutputs: ['That feature sounds great'],
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the spring launch of our photo app to existing users',
    );
    await user.click(screen.getByTestId('eb-send'));

    // A plain-prose reply is salvaged as the reply (flash may appear), and no
    // page-top warning banner is raised for a chat outcome.
    expect(
      await screen.findByText('That feature sounds great', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('eb-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eb-repair-offer')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.5 declutter: model picker starts tucked away as a quiet toggle', async () => {
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);

    expect(await screen.findByTestId('eb-model-toggle')).toHaveTextContent(/Model:/);
    expect(screen.queryByTestId('eb-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('eb-send')).toBeDisabled();
  }, 20000);


  it('v0.1.6: nothing shows before it has content — chat owns the empty state', async () => {
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, consentGranted: true });
    render(<App />);

    expect(await screen.findByTestId('eb-chat-input')).toBeInTheDocument();
    // No empty Brief card, no empty preview card, no empty library card.
    expect(screen.queryByTestId('eb-brief')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eb-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eb-drafts')).not.toBeInTheDocument();
    // Full-width shell (no 1180px cage).
    expect(screen.getByTestId('eb-app').style.maxWidth).not.toBe('1180px');
    expect(screen.queryByTestId('eb-next-generate')).not.toBeInTheDocument();
  }, 20000);

  it('v0.1.6: a ready brief surfaces the next step inside the chat', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE],
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'I want to announce our v2 launch to free users',
    );
    await user.click(screen.getByTestId('eb-send'));
    expect(
      await screen.findByText(/Here is your brief/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // The brief card appears now that it has content, and the chat itself
    // names the next action.
    expect(screen.getByTestId('eb-brief')).toBeInTheDocument();
    await user.click(await screen.findByTestId('eb-next-generate'));
    expect(await screen.findByTestId('eb-confirm')).toHaveTextContent(/email package/);
    await user.click(screen.getByTestId('eb-confirm-run'));
    expect(
      await screen.findByTestId('eb-variant-variant-1', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('PhotoApp v2.0 is live');
  }, 20000);


  it('v0.1.9: a banner that comes back empty leaves the slot + a chat note, and the slot retries', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE],
      failFirstBanner: true,
    });
    render(<App />);
    await driveToBundle(user, { expectBanner: false });

    // Package landed; the leg missed honestly, in the transcript.
    expect(
      await screen.findByText(/banner came back without an image/, {}, { timeout: 15000 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('eb-banner-placeholder')).toHaveTextContent(
      'Your banner image will appear here',
    );

    // The slot's own button retries through the normal priced confirm.
    await user.click(screen.getByTestId('eb-banner-generate-slot'));
    expect(await screen.findByTestId('eb-confirm')).toHaveTextContent(/up to/);
    await user.click(screen.getByTestId('eb-confirm-run'));
    expect(
      await screen.findByTestId('eb-banner-img', {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 45000);


  it('v0.1.11: sessions live in the chat card; header drops New email / Save draft', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      cost: 4,
      pollsUntilDone: 1,
      stepTextOutputs: [INTERVIEW_READY, BUNDLE],
    });
    render(<App />);

    // The header keeps only the current-campaign label; saving is automatic.
    expect(await screen.findByTestId('eb-sessions')).toBeInTheDocument();
    expect(screen.queryByTestId('eb-new')).not.toBeInTheDocument();
    expect(screen.queryByTestId('eb-save-draft')).not.toBeInTheDocument();

    await driveToBundle(user);

    // A manual tweak rides along when jumping between campaigns.
    await user.click(screen.getByTestId('eb-edit-toggle'));
    const headline = screen.getByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'Edited by hand');

    await user.click(screen.getByTestId('eb-session-new'));
    expect(screen.getByTestId('eb-current-draft')).toHaveTextContent(/Untitled email/);

    const sessionsBar = within(screen.getByTestId('eb-sessions'));
    await user.click(
      sessionsBar.getByRole('button', { name: 'Announce the v2.0 release of our photo app' }),
    );
    expect(screen.getByTestId('eb-current-draft')).toHaveTextContent(
      /Announce the v2\.0 release/,
    );
    await user.click(screen.getByTestId('eb-edit-toggle'));
    expect(screen.getByLabelText('Headline')).toHaveValue('Edited by hand');
  }, 30000);


  it('v0.1.12 focus: preview leads the generated workspace and manual edits start collapsed', async () => {
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

    const preview = screen.getByTestId('eb-preview');
    const options = screen.getByTestId('eb-package-options');
    expect(
      preview.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByLabelText('Headline')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('eb-edit-toggle'));
    expect(screen.getByLabelText('Headline')).toBeInTheDocument();
  }, 30000);

  it('v0.1.13: saved status stays put instead of expiring and reappearing', async () => {
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

    // The combined package flashes a separate completion message; let that
    // legitimate transient expire before judging the saved status.
    await waitFor(
      () => {
        expect(screen.queryByTestId('eb-flash')).not.toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    const savedStatus = await screen.findByTestId('eb-saved-status', {}, { timeout: 8000 });
    expect(savedStatus).toHaveTextContent(/saved/i);

    // Longer than the old 3.5s transient flash lifetime: the same status node
    // must still be there, with no transient flash cycling underneath it.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(screen.getByTestId('eb-saved-status')).toBe(savedStatus);
    expect(screen.queryByTestId('eb-flash')).not.toBeInTheDocument();
  }, 30000);


  it('v0.1.14: a packaged draft saved without a draft widget gets one when reopened', async () => {
    const user = userEvent.setup();
    // Shaped like the live §8.8 account: a finished package whose transcript
    // ends with the interview turns (saved before the widget existed).
    const legacySeed = {
      'draft:legacy-1': {
        id: 'legacy-1',
        name: 'Announce the new orange shampoo product',
        brief: {
          purpose: 'Announce the new orange shampoo product',
          audience: 'existing customers',
          tone: 'fresh and upbeat',
          ctaText: 'Shop the launch',
          ctaUrl: 'https://example.com/shampoo',
          keyPoints: ['cold-pressed orange oil', 'sulfate-free'],
          senderName: 'The Citrus Co. team',
          bannerVibe: 'bright oranges and shampoo bottle on a sunny counter',
        },
        subjects: ['Orange you glad?', 'New: orange shampoo', 'A fresher wash is here'],
        preheader: 'Cold-pressed orange oil, sulfate-free',
        variants: [
          {
            id: 'variant-1',
            name: 'Announcement',
            headline: 'Orange shampoo has landed',
            body: ['Our new orange shampoo is here.'],
            ctaText: 'Shop the launch',
            bannerPrompt: 'bright oranges beside a shampoo bottle, no text',
          },
        ],
        selectedVariantId: 'variant-1',
        bannerUrl: '',
        bannerWorkflowId: '',
        transcript: [
          { role: 'assistant', content: 'Tell me about the email you want to send…' },
          { role: 'user', content: 'Announce the new orange shampoo product' },
          {
            role: 'assistant',
            content: 'Here is your brief: an orange shampoo launch for existing customers. Look right?',
          },
        ],
        updatedAt: '2026-10-07T15:00:00.000Z',
      },
    };
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      storage: { seed: legacySeed },
    });
    render(<App />);

    await user.click(await screen.findByTestId('eb-drafts-open', {}, { timeout: 5000 }));
    const drawer = await screen.findByTestId('eb-drafts-drawer');
    await user.click(within(drawer).getByRole('button', { name: 'Open' }));

    // The reopened finished campaign carries its draft card, exactly once,
    // and the finished package is on screen.
    expect(await screen.findByTestId('eb-draft-widget', {}, { timeout: 5000 })).toHaveTextContent(
      'Your email draft',
    );
    expect(screen.getAllByTestId('eb-draft-widget')).toHaveLength(1);
    expect(screen.getByTestId('eb-preview')).toHaveTextContent('Orange shampoo has landed');
    expect(screen.getByTestId('eb-subject-0')).toHaveTextContent('Orange you glad?');
  }, 20000);

  it('v0.1.14: an interview turn that returns nothing offers a one-tap resend', async () => {
    const user = userEvent.setup();
    let submits = 0;
    uninstall = installMockMoneyHost({
      viewer: { ...VIEWER },
      consentGranted: true,
      // No canned replies: the step completes with nothing displayable,
      // which is the shape the live §8.8 run hit (held-back turn).
      stepTextOutputs: [],
      onOutbound: (msg) => {
        if ((msg as { type?: string }).type === 'SUBMIT_WORKFLOW') submits++;
      },
    });
    render(<App />);

    await user.type(
      await screen.findByTestId('eb-chat-input'),
      'Announce the new orange shampoo product to existing customers',
    );
    await user.click(screen.getByTestId('eb-send'));

    // The turn is held honestly in the transcript, and the resend offer —
    // not a bare "type it again" — carries its own charge disclosure.
    expect(
      await screen.findByText(/didn’t reply/, {}, { timeout: 8000 }),
    ).toBeInTheDocument();
    const offer = await screen.findByTestId('eb-repair-offer', {}, { timeout: 5000 });
    expect(offer).toHaveTextContent(/send that again/i);
    expect(screen.getByTestId('eb-repair-run')).toHaveTextContent('Send again');

    await user.click(screen.getByTestId('eb-repair-run'));
    await waitFor(() => expect(submits).toBe(2));
  }, 20000);


  it('§8.8 subject-pick: picking a subject writes through to the editor (narrow, editor behind toggle)', async () => {
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

    // Narrow parity pins (§8.8 asks both layouts keep their keys): the
    // library lives behind eb-drafts-open / eb-drafts-drawer here.
    expect(screen.getByTestId('eb-drafts-open')).toBeInTheDocument();
    expect(screen.queryByTestId('eb-drafts')).not.toBeInTheDocument();

    // The copy editor starts closed; pick subject #2 first, THEN open it —
    // the live walk read the (unmounted) field and saw "". The pick must
    // already be the editor's value when it mounts.
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('eb-subject-1'));
    await user.click(screen.getByTestId('eb-edit-toggle'));
    expect(screen.getByLabelText('Subject')).toHaveValue('Your photos, upgraded');

    // And the edit path writes back into the picked slot.
    const subject = screen.getByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Rewritten by hand');
    expect(screen.getByTestId('eb-subject-1')).toHaveTextContent('Rewritten by hand');
  }, 30000);

  it('§8.8 subject-pick: same write-through in the wide layout (drafts card, same editor)', async () => {
    // Force the wide tier: jsdom has no ResizeObserver, so the breakpoint
    // hook sits at 'base' (narrow). A wide fake RO flips it after mount.
    class WideRO {
      constructor(private cb: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.cb(
            [{ target, contentRect: { width: 1400, height: 900 } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', WideRO);
    try {
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

      // Wide parity pins: the drafts card renders in place (no drawer
      // button), its toggle carries aria-expanded, rows keep their menus.
      expect(await screen.findByTestId('eb-drafts', {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.queryByTestId('eb-drafts-open')).not.toBeInTheDocument();
      const toggle = screen.getByTestId('eb-drafts-toggle');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(
        document.querySelector('[data-testid^="eb-draft-menu-"]'),
      ).not.toBeNull();

      // Same write-through: pick while the editor is closed, open, read.
      expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
      await user.click(screen.getByTestId('eb-subject-1'));
      await user.click(screen.getByTestId('eb-edit-toggle'));
      expect(screen.getByLabelText('Subject')).toHaveValue('Your photos, upgraded');
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30000);
});
