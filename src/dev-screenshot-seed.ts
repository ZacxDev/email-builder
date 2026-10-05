/**
 * TEMPORARY screenshot rig — seeded demo draft for the mock host storage
 * scenario, so review screenshots show a saved template in the drafts list.
 * Dev-harness only (the mock host's storage seed); production storage is
 * untouched.
 */
export const SCREENSHOT_SEED: Record<string, unknown> = {
  'draft:demo-1': {
    id: 'demo-1',
    name: 'Spring launch announcement',
    brief: {
      purpose: 'Announce the spring launch of our photo-editing app v2',
      audience: 'existing free users',
      tone: 'excited but not cringe',
      ctaText: 'Try v2 free',
      ctaUrl: 'https://example.com/v2',
      keyPoints: ['AI background removal', '2x faster exports'],
      senderName: 'The PhotoApp team',
      bannerVibe: 'bright studio photo of a phone showing a before/after edit',
    },
    subjects: ['V2 is here — your photos, upgraded'],
    preheader: 'Background removal + 2x faster exports, free to try',
    variants: [
      {
        id: 'variant-1',
        name: 'Announcement',
        headline: 'PhotoApp v2 is live',
        body: ['Our biggest update yet just landed.'],
        ctaText: 'Try v2 free',
        bannerPrompt: 'bright studio photo of a phone showing a before/after edit, no text',
      },
    ],
    selectedVariantId: 'variant-1',
    bannerUrl: '',
    bannerWorkflowId: 'wf-demo',
    transcript: [
      { role: 'assistant', content: 'Tell me about the email you want to send…' },
      { role: 'user', content: 'Announce our spring v2 launch to free users' },
      { role: 'assistant', content: 'Here is your brief: a v2 launch email for existing free users. Look right?' },
      {
        role: 'assistant',
        content: 'Your email draft is ready — pick a variant, or keep chatting to revise it.',
        widget: {
          type: 'draft',
          subjects: ['V2 is here — your photos, upgraded', 'Spring launch: AI background removal is live'],
          variants: [
            { id: 'variant-1', name: 'Announcement', headline: 'PhotoApp v2 is live' },
            { id: 'variant-2', name: 'Minimal', headline: 'Less editing. More photo.' },
          ],
        },
      },
    ],
    updatedAt: '2026-10-04T15:00:00.000Z',
  },
};
