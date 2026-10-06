// Permanent walk seed for the Email Builder dev harness (mock host only).
//
// WHAT THIS IS
//   A realistic, lived-in demo dataset so `npm run dev:harness` (plus the
//   seed URL below) opens the app with a small library of drafts at
//   different stages — no clicking or dummy-data typing needed to review
//   the app. Consumed by:
//     - `npm run walk`        (tools/walk/run.mjs drives these states)
//     - `npm run seed:url`    (prints a URL that loads this seed manually)
//
// HOW IT LOADS (no app code involved)
//   The SDK mock host's `readMockHostUrlOptions()` parses `?seed=<JSON>`
//   into `storage.seed`, and src/Harness.tsx merges it over the existing
//   screenshot-rig seed (`draft:demo-1` stays untouched). Mock storage is
//   in-memory per page load, so every visit re-seeds from scratch —
//   deterministic and idempotent by construction. Values must match the
//   EmailDraft shape in src/email/email.ts (rows are normalized on read;
//   malformed rows are dropped silently, so keep the shape exact).
//   Keep the dataset tight: it travels in the URL, and the dev server
//   refuses oversized request headers.
//
// DETERMINISM
//   Fixed ids, fixed updatedAt stamps, no Date.now()/random anywhere.
//   The banner "image" is an inline SVG data URI (same trick as the App's
//   own ?seed=demo state) so screenshots never depend on the network.
//   The broken-banner draft points at a same-origin path that 404s on the
//   dev server, which is exactly what an expired signed URL looks like.

const GREETING =
  "Tell me about the email you want to send — what it's for, who it's going to, and anything it has to include. I'll ask follow-ups until the brief is ready.";

const bannerSvg =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='675'><rect width='1200' height='675' fill='#123a6d'/>` +
      `<text x='60' y='330' font-family='Arial' font-size='76' font-weight='700' fill='white'>Spring Sale</text>` +
      `<text x='60' y='400' font-family='Arial' font-size='34' fill='#ffe8cc'>Up to 40% off annual plans</text></svg>`,
  );

const brief = (over) => ({
  purpose: '',
  audience: '',
  tone: '',
  ctaText: '',
  ctaUrl: '',
  keyPoints: [],
  senderName: '',
  bannerVibe: '',
  ...over,
});

const widgetTurn = (subjects, variants) => ({
  role: 'assistant',
  content: 'Your email draft is ready — pick a variant, or keep chatting to revise it.',
  widget: { type: 'draft', subjects, variants },
});

/** The seed as the mock host expects it: storage key -> draft row. */
export const WALK_SEED = {
  // Stage 1: interview still running. Brief half-filled (purpose + tone
  // only, so NOT ready), no package yet.
  'draft:walk-interview': {
    id: 'walk-interview',
    name: 'Dark mode launch',
    brief: brief({ purpose: 'Announce the new dark mode in our app', tone: 'playful and short' }),
    subjects: [],
    preheader: '',
    variants: [],
    selectedVariantId: '',
    bannerUrl: '',
    bannerWorkflowId: '',
    transcript: [
      { role: 'assistant', content: GREETING },
      { role: 'user', content: 'I want to email our users about the new dark mode in our app' },
      { role: 'assistant', content: 'Love it. Who gets it first — everyone, or the beta group?' },
      { role: 'user', content: 'Beta users first. Keep it short and playful.' },
    ],
    updatedAt: '2026-10-04T10:00:00.000Z',
  },

  // Stage 2: brief complete and ready, package not generated yet.
  'draft:walk-brief': {
    id: 'walk-brief',
    name: 'October newsletter',
    brief: brief({
      purpose: 'Monthly product newsletter for October',
      audience: 'all subscribers',
      tone: 'warm and concise',
      ctaText: 'Read the October roundup',
      ctaUrl: 'https://example.com/newsletter/october',
      keyPoints: ['New templates gallery', 'Faster exports', 'Community spotlight'],
      senderName: 'The PhotoApp team',
      bannerVibe: 'autumn desk flat-lay, laptop and coffee, warm light, no text',
    }),
    subjects: [],
    preheader: '',
    variants: [],
    selectedVariantId: '',
    bannerUrl: '',
    bannerWorkflowId: '',
    transcript: [
      { role: 'assistant', content: GREETING },
      { role: 'user', content: 'Our October newsletter — what shipped, for all subscribers' },
      {
        role: 'assistant',
        content: 'Here is your brief: an October newsletter for all subscribers. Look right?',
      },
    ],
    updatedAt: '2026-10-04T12:30:00.000Z',
  },

  // Stage 3: package generated (subjects + variants), no banner yet.
  'draft:walk-nobanner': {
    id: 'walk-nobanner',
    name: 'Product tips digest',
    brief: brief({
      purpose: 'Weekly tips digest for power users',
      audience: 'power users',
      tone: 'practical, zero fluff',
      ctaText: 'See all tips',
      ctaUrl: 'https://example.com/tips',
      keyPoints: ['Keyboard shortcuts roundup', 'Batch export trick'],
      senderName: 'The PhotoApp team',
      bannerVibe: 'clean workspace, sticky notes of shortcuts, top-down, no text',
    }),
    subjects: ['5 shortcuts you are probably not using', 'Your weekly tips digest'],
    preheader: 'Shortcuts, batch exports, one hidden setting',
    variants: [
      {
        id: 'variant-1',
        name: 'Checklist',
        headline: 'Five shortcuts, two minutes',
        body: [
          'The fastest users barely touch the mouse. These five shortcuts cover most of a session.',
          'Start with batch export — the one people ask about most.',
        ],
        ctaText: 'See all tips',
        bannerPrompt: 'clean workspace, sticky notes of shortcuts, top-down, no text',
      },
      {
        id: 'variant-2',
        name: 'Direct',
        headline: 'Work faster this week',
        body: ['Batch export alone saves an hour. The other four tips are gravy.'],
        ctaText: 'See all tips',
        bannerPrompt: 'minimal desk, keyboard in warm light, no text',
      },
    ],
    selectedVariantId: 'variant-1',
    bannerUrl: '',
    bannerWorkflowId: '',
    transcript: [
      { role: 'assistant', content: GREETING },
      { role: 'user', content: 'Weekly tips digest for our power users' },
      { role: 'assistant', content: 'Here is your brief: a practical tips digest. Look right?' },
      widgetTurn(
        ['5 shortcuts you are probably not using', 'Your weekly tips digest'],
        [
          { id: 'variant-1', name: 'Checklist', headline: 'Five shortcuts, two minutes' },
          { id: 'variant-2', name: 'Direct', headline: 'Work faster this week' },
        ],
      ),
    ],
    updatedAt: '2026-10-03T16:20:00.000Z',
  },

  // Stage 4: finished — package + banner in place.
  'draft:walk-banner': {
    id: 'walk-banner',
    name: 'Spring sale announcement',
    brief: brief({
      purpose: 'Announce the spring sale, up to 40% off annual plans',
      audience: 'free users',
      tone: 'bright and direct',
      ctaText: 'Shop the sale',
      ctaUrl: 'https://example.com/sale',
      keyPoints: ['Up to 40% off annual plans', 'Ends Sunday'],
      senderName: 'The PhotoApp team',
      bannerVibe: 'spring studio shot, coral and navy, product on pedestal, no text',
    }),
    subjects: ['Spring sale: up to 40% off annual', 'Your upgrade is 40% off until Sunday'],
    preheader: 'Annual plans up to 40% off — ends Sunday',
    variants: [
      {
        id: 'variant-1',
        name: 'Announcement',
        headline: 'Spring refresh: up to 40% off',
        body: [
          'Annual plans are up to 40% off until Sunday — same PhotoApp, one less thing to think about.',
          'Upgrade once and the discount covers your whole year.',
        ],
        ctaText: 'Shop the sale',
        bannerPrompt: 'spring studio shot, coral and navy, product on pedestal, no text',
      },
      {
        id: 'variant-2',
        name: 'Minimal',
        headline: '40% off. Until Sunday.',
        body: ['Annual plans, up to 40% off. That is the whole email.'],
        ctaText: 'Shop the sale',
        bannerPrompt: 'minimal coral gradient, single product card, no text',
      },
    ],
    selectedVariantId: 'variant-1',
    bannerUrl: bannerSvg,
    bannerWorkflowId: 'wf-walk-banner-1',
    transcript: [
      { role: 'assistant', content: GREETING },
      { role: 'user', content: 'Announce our spring sale to free users — up to 40% off annual' },
      { role: 'assistant', content: 'Here is your brief: a spring sale email. Look right?' },
      widgetTurn(
        ['Spring sale: up to 40% off annual', 'Your upgrade is 40% off until Sunday'],
        [
          { id: 'variant-1', name: 'Announcement', headline: 'Spring refresh: up to 40% off' },
          { id: 'variant-2', name: 'Minimal', headline: '40% off. Until Sunday.' },
        ],
      ),
    ],
    updatedAt: '2026-10-05T09:15:00.000Z',
  },

  // Stage 5: finished, but the banner URL is dead (expired link), so the
  // preview must show its "banner unavailable — regenerate" fallback.
  'draft:walk-broken': {
    id: 'walk-broken',
    name: 'Webinar invite',
    brief: brief({
      purpose: 'Invite subscribers to the live workflow webinar',
      audience: 'all subscribers',
      tone: 'friendly expert',
      ctaText: 'Save my seat',
      ctaUrl: 'https://example.com/webinar',
      keyPoints: ['Live Q&A', 'Replay for registrants'],
      senderName: 'The PhotoApp team',
      bannerVibe: 'webinar stage, big screen, coral accents, no text',
    }),
    subjects: ['Live webinar: edit faster, start to finish', 'Your seat for Thursday is open'],
    preheader: 'Live Q&A Thursday — replay included',
    variants: [
      {
        id: 'variant-1',
        name: 'Invite',
        headline: 'Edit faster, live on Thursday',
        body: [
          'A 45-minute live walkthrough of the full editing workflow, Q&A at the end.',
          'Can’t make it? Register anyway — the replay lands in your inbox.',
        ],
        ctaText: 'Save my seat',
        bannerPrompt: 'webinar stage, big screen, coral accents, no text',
      },
    ],
    selectedVariantId: 'variant-1',
    // Same-origin 404 on the dev server: renders exactly like an expired
    // signed banner URL, deterministically, with no external network.
    bannerUrl: 'http://localhost:5186/__walk-expired-banner.png',
    bannerWorkflowId: 'wf-walk-broken-1',
    transcript: [
      { role: 'assistant', content: GREETING },
      { role: 'user', content: 'Invite everyone to Thursday’s workflow webinar' },
      { role: 'assistant', content: 'Here is your brief: a webinar invite. Look right?' },
      widgetTurn(
        ['Live webinar: edit faster, start to finish', 'Your seat for Thursday is open'],
        [{ id: 'variant-1', name: 'Invite', headline: 'Edit faster, live on Thursday' }],
      ),
    ],
    updatedAt: '2026-10-04T18:45:00.000Z',
  },
};

/** `seed=…` query pair that loads WALK_SEED into the mock host. */
export function seedQuery() {
  return `seed=${encodeURIComponent(JSON.stringify(WALK_SEED))}`;
}

/** Full harness URL with the walk seed applied. */
export function seededUrl(base = 'http://localhost:5186') {
  return `${base}/?${seedQuery()}`;
}
