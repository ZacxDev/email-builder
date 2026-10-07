// email.ts — P0 spike pins for the Email Builder generation contracts.
//
// The load-bearing facts, all verified against developer.civitai.com docs +
// the installed SDK types on 2026-10-04:
//  - copy/interview runs on the REGISTERED chat-completion step with the
//    allowlisted `deepseek/deepseek-v4-flash-0731` (a fabricated model is charged, then
//    fails with no refund);
//  - the banner runs on the PASS-THROUGH arm: `kind: 'step'` with the `step`
//    key ABSENT and `$type: 'imageGen'`, input forwarded unmodified in the
//    orchestration google-recipe shape (engine google, model nano-banana-2);
//  - `maxBuzz` (1…250) is both the spend ceiling and the timeout in seconds,
//    and must fit under the manifest's buzzBudgetPerGen (300);
//  - model JSON replies are parsed tolerantly (fences/prose) but never
//    fabricated: unparseable → null, callers keep prior state.

import { describe, expect, it } from 'vitest';
import type { BlockWorkflowSnapshot, WorkflowBody, WorkflowBodyStep } from '@civitai/app-sdk/blocks';

/** Narrow a body to the registry arm or fail the test loudly. */
function asStep(body: WorkflowBody): WorkflowBodyStep {
  if (body.kind !== 'step' || !('step' in body) || typeof body.step !== 'string') {
    throw new Error('expected registry arm');
  }
  return body as WorkflowBodyStep;
}

import {
  BANNER_ASPECT_RATIO,
  BANNER_ENGINE,
  BANNER_MAX_BUZZ,
  BANNER_MODEL,
  BANNER_STEP_TYPE,
  BUNDLE_MAX_TOKENS,
  CHAT_MODEL,
  EMPTY_BRIEF,
  bannerUrlFromSnapshot,
  buildEmailHtml,
  emailExportFilename,
  briefIsReady,
  buildRefineBody,
  buildBannerBody,
  buildBundleBody,
  buildInterviewBody,
  idempotencyKeyFor,
  newDraft,
  normalizeDraft,
  parseEmailBundle,
  parseRefinedVariant,
  replaceVariant,
  parseInterviewTurn,
  textOutcomeFromSnapshot,
  salvageInterviewTurn,
  salvageEmailBundle,
  salvageRefinedVariant,
  interviewTurnProblem,
  emailBundleProblem,
  buildRepairBody,
  mergeBriefs,
  unwrapTextEnvelope,
  CHAT_MODELS,
  isChatModelId,
} from './email.js';

const BRIEF = {
  ...EMPTY_BRIEF,
  purpose: 'Announce the v2.0 release of our photo app',
  audience: 'existing free users',
  tone: 'excited but not cringe',
  ctaText: 'Try v2.0 free',
  ctaUrl: 'https://example.com/v2',
  keyPoints: ['AI background removal', '2x faster exports'],
  senderName: 'The PhotoApp team',
  bannerVibe: 'bright studio photo of a phone showing before/after edits',
};

describe('buildInterviewBody / buildBundleBody (registry arm)', () => {
  it('targets the registered chat-completion step with the allowlisted model', () => {
    for (const body of [
      buildInterviewBody([{ role: 'user', content: 'I need a launch email' }]),
      buildBundleBody(BRIEF),
    ]) {
      expect(body.kind).toBe('step');
      const stepBody = asStep(body);
      expect(stepBody.step).toBe('chat-completion');
      expect(stepBody.params.model).toBe(CHAT_MODEL);
      expect(CHAT_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
      expect(typeof stepBody.params.maxTokens).toBe('number');
      expect(stepBody.params.maxTokens as number).toBeGreaterThan(0);
      // Registry arm is .strict(): exactly kind/step/params, no $type/maxBuzz.
      expect(Object.keys(body).sort()).toEqual(['kind', 'params', 'step']);
    }
  });

  it('bundle body carries the brief as JSON and reserves real token headroom', () => {
    const stepBody = asStep(buildBundleBody(BRIEF));
    expect(stepBody.params.maxTokens).toBe(BUNDLE_MAX_TOKENS);
    const messages = stepBody.params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    // messages[1..2] are the few-shot exemplar pair; the real brief is last.
    expect(messages[messages.length - 1]?.content).toContain('AI background removal');
    expect(messages[1]?.content).toContain('Announce dark mode');
  });

  it('interview system prompt enforces the JSON turn contract', () => {
    const stepBody = asStep(buildInterviewBody([]));
    const messages = stepBody.params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('"ready"');
    expect(messages[0]?.content).toContain('ONE short question');
  });
});

describe('buildBannerBody (pass-through arm)', () => {
  it('omits the step key entirely — its absence is the arm discriminator', () => {
    const body = buildBannerBody('  a bright banner  ');
    expect(body.kind).toBe('step');
    expect('step' in body).toBe(false);
    if (body.kind !== 'step' || !('$type' in body)) throw new Error('expected pass-through arm');
    expect(body.$type).toBe(BANNER_STEP_TYPE);
    expect(Object.keys(body).sort()).toEqual(['$type', 'input', 'kind', 'maxBuzz']);
  });

  it('forwards the orchestration google-recipe input unmodified', () => {
    const body = buildBannerBody('a bright banner');
    if (body.kind !== 'step' || !('$type' in body)) throw new Error('expected pass-through arm');
    expect(body.input).toEqual({
      engine: BANNER_ENGINE,
      model: BANNER_MODEL,
      prompt: 'a bright banner',
      aspectRatio: BANNER_ASPECT_RATIO,
      resolution: '1K',
      numImages: 1,
    });
    expect(BANNER_ENGINE).toBe('google');
    expect(BANNER_MODEL).toBe('nano-banana-2'); // Gemini 2.5 Flash Image
    expect(BANNER_ASPECT_RATIO).toBe('16:9');
  });

  it('maxBuzz covers the 104 Buzz 1K price, fits the 1…250 cap and the page budget', () => {
    expect(BANNER_MAX_BUZZ).toBe(150);
    expect(BANNER_MAX_BUZZ).toBeGreaterThanOrEqual(104);
    expect(BANNER_MAX_BUZZ).toBeLessThanOrEqual(250);
    expect(BANNER_MAX_BUZZ).toBeLessThanOrEqual(300); // manifest buzzBudgetPerGen
  });
});

describe('parseInterviewTurn', () => {
  it('parses a ready turn and normalizes the brief', () => {
    const text = JSON.stringify({
      reply: 'Here is your brief — look right?',
      ready: true,
      brief: { ...BRIEF, keyPoints: ['AI background removal', '2x faster exports', 'AI background removal'] },
    });
    const turn = parseInterviewTurn(text);
    expect(turn?.reply).toContain('brief');
    expect(turn?.ready).toBe(true);
    expect(turn?.brief.keyPoints).toEqual(['AI background removal', '2x faster exports']);
  });

  it('never reports ready when the brief is still un-generatable', () => {
    const text = JSON.stringify({ reply: 'Who is this email for?', ready: true, brief: EMPTY_BRIEF });
    const turn = parseInterviewTurn(text);
    expect(turn?.ready).toBe(false);
    expect(briefIsReady(turn!.brief)).toBe(false);
  });

  it('tolerates markdown fences and prose around the JSON', () => {
    const inner = JSON.stringify({ reply: 'What tone?', ready: false, brief: EMPTY_BRIEF });
    expect(parseInterviewTurn('```json\n' + inner + '\n```')?.reply).toBe('What tone?');
    expect(parseInterviewTurn('Sure! ' + inner + ' Hope that helps')?.reply).toBe('What tone?');
  });

  it('returns null (never fabricates) on unparseable text', () => {
    expect(parseInterviewTurn('no json here')).toBeNull();
    expect(parseInterviewTurn('{"reply": 42}')).toBeNull();
    expect(parseInterviewTurn('')).toBeNull();
  });
});

describe('parseEmailBundle', () => {
  const bundleJson = JSON.stringify({
    subjects: ['V2 is here', 'Your photos, upgraded', 'V2 is here'],
    preheader: 'Background removal + faster exports',
    variants: [
      { id: 'a', name: 'Announcement', headline: 'PhotoApp v2.0 is live', body: ['P1', 'P2'], ctaText: 'Try it', bannerPrompt: 'bright studio banner, no text' },
      { id: 'b', name: 'Minimal', headline: 'Less editing. More photo.', body: ['P1'], ctaText: 'Try it', bannerPrompt: 'minimal banner, no text' },
      { id: 'c', name: 'Broken', headline: '', body: [], ctaText: '', bannerPrompt: '' },
      { id: 'd', name: 'Extra', headline: 'Fourth', body: ['P1'], ctaText: 'Go', bannerPrompt: 'x' },
    ],
  });

  it('caps subjects/variants at 3, dedupes, drops junk variants', () => {
    const bundle = parseEmailBundle(bundleJson);
    expect(bundle?.subjects).toEqual(['V2 is here', 'Your photos, upgraded']);
    expect(bundle?.variants.map((v) => v.id)).toEqual(['a', 'b', 'd']);
    expect(bundle?.preheader).toContain('Background removal');
  });

  it('returns null when there is nothing usable', () => {
    expect(parseEmailBundle('{"subjects": [], "variants": []}')).toBeNull();
    expect(parseEmailBundle('not json')).toBeNull();
  });
});

describe('snapshot readers', () => {
  const snap = (over: Record<string, unknown>): BlockWorkflowSnapshot =>
    ({ workflowId: 'wf-1', status: 'succeeded', ...over }) as BlockWorkflowSnapshot;

  it('reads released text first, then the withheld reason, else none', () => {
    expect(textOutcomeFromSnapshot(snap({ textOutputs: ['', '  hello  '] }))).toEqual({ type: 'text', text: 'hello' });
    expect(textOutcomeFromSnapshot(snap({ textOutputs: [], textOutputWithheld: { reason: 'flagged' } }))).toEqual({ type: 'withheld', reason: 'flagged' });
    expect(textOutcomeFromSnapshot(snap({}))).toEqual({ type: 'none' });
  });

  it('banner URL is the first image URL or null', () => {
    expect(bannerUrlFromSnapshot(snap({ imageUrls: ['https://img/1.png', 'https://img/2.png'] }))).toBe('https://img/1.png');
    expect(bannerUrlFromSnapshot(snap({ imageUrls: [] }))).toBeNull();
    expect(bannerUrlFromSnapshot(null)).toBeNull();
  });
});

describe('refinement + idempotency keys', () => {
  it('refine body targets the chat step and carries variant + instruction', () => {
    const variant = { id: 'a', name: 'A', headline: 'H', body: ['B1'], ctaText: 'Go', bannerPrompt: 'p' };
    const body = buildRefineBody(variant, '  make it shorter  ', BRIEF);
    const stepBody = asStep(body);
    expect(stepBody.step).toBe('chat-completion');
    const messages = stepBody.params.messages as Array<{ content: string }>;
    const last = messages[messages.length - 1];
    expect(last?.content).toContain('make it shorter');
    expect(last?.content).toContain('"headline":"H"');
  });

  it('parseRefinedVariant keeps id/name and validates shape', () => {
    const base = { id: 'a', name: 'A', headline: 'H', body: ['B1'], ctaText: 'Go', bannerPrompt: 'p' };
    const out = parseRefinedVariant('{"headline":"H2","body":["B2"],"ctaText":"Go2","bannerPrompt":"p2"}', base);
    expect(out).toEqual({ id: 'a', name: 'A', headline: 'H2', body: ['B2'], ctaText: 'Go2', bannerPrompt: 'p2' });
    expect(parseRefinedVariant('junk', base)).toBeNull();
    expect(replaceVariant([base], out!).map((v) => v.headline)).toEqual(['H2']);
  });

  it('idempotency keys are stable, host-legal, and colon-free', () => {
    const k1 = idempotencyKeyFor('draft:abc:bundle:0');
    expect(k1).toBe(idempotencyKeyFor('draft:abc:bundle:0'));
    expect(k1).not.toBe(idempotencyKeyFor('draft:abc:bundle:1'));
    expect(k1).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(k1).not.toContain(':');
  });

  it('newDraft is a clean empty draft', () => {
    const d = newDraft('d9', '2026-10-04T00:00:00Z');
    expect(d).toMatchObject({ id: 'd9', subjects: [], variants: [], bannerWorkflowId: '' });
    expect(normalizeDraft(d)).toEqual(d);
  });
});

describe('emailExportFilename', () => {
  it('slugifies draft names and always ends in .html', () => {
    expect(emailExportFilename('Spring Launch!')).toBe('spring-launch.html');
    expect(emailExportFilename('  V2 — Photos, Upgraded  ')).toBe('v2-photos-upgraded.html');
    expect(emailExportFilename('')).toBe('email.html');
    expect(emailExportFilename('!!!')).toBe('email.html');
  });
});

describe('buildEmailHtml (export)', () => {
  it('renders a table-based doc with banner, copy, CTA and escapes HTML', () => {
    const draft = {
      ...newDraft('d1', '2026-10-04T00:00:00Z'),
      brief: { ...BRIEF },
      bannerUrl: 'https://img/banner.png',
    };
    const variant = { id: 'a', name: 'A', headline: 'Big <news>', body: ['Hello & welcome'], ctaText: 'Try it', bannerPrompt: 'p' };
    const html = buildEmailHtml(draft, variant, 'Subject');
    expect(html).toContain('<table role="presentation" width="600"');
    expect(html).toContain('https://img/banner.png');
    expect(html).toContain('Big &lt;news&gt;');
    expect(html).toContain('Hello &amp; welcome');
    expect(html).toContain('https://example.com/v2');
    expect(html).not.toContain('<script');
  });
});

describe('normalizeDraft (storage round-trip)', () => {
  it('keeps a valid draft and repairs the selection', () => {
    const draft = normalizeDraft({
      id: 'd1',
      name: 'Launch',
      brief: BRIEF,
      subjects: ['S1'],
      variants: [{ id: 'a', name: 'A', headline: 'H', body: ['B'], ctaText: 'Go', bannerPrompt: 'p' }],
      selectedVariantId: 'missing',
      bannerUrl: 'https://img/1.png',
      bannerWorkflowId: 'wf-9',
      updatedAt: '2026-10-04T00:00:00Z',
    });
    expect(draft?.selectedVariantId).toBe('a');
    expect(draft?.bannerWorkflowId).toBe('wf-9');
    expect(draft?.brief.purpose).toContain('v2.0');
  });

  it('rejects junk rows', () => {
    expect(normalizeDraft(null)).toBeNull();
    expect(normalizeDraft({ name: 'no id' })).toBeNull();
    expect(normalizeDraft('nope')).toBeNull();
  });
});

describe('salvage + repair (v0.1.3)', () => {
  it('rescues a truncated interview reply without inventing content', () => {
    const truncated =
      '{"reply":"What link should the button use?","ready":false,"brief":{"purpose":"Launch em';
    const read = salvageInterviewTurn(truncated);
    expect(read?.recovered).toBe(true);
    expect(read?.result.reply).toBe('What link should the button use?');
    expect(read?.result.ready).toBe(false);
  });

  it('rescues plain prose as the reply the user paid for', () => {
    const read = salvageInterviewTurn('Sure — who is this email for?');
    expect(read?.recovered).toBe(true);
    expect(read?.result.reply).toContain('who is this email for');
    expect(interviewTurnProblem('Sure — who is this email for?')).not.toBeNull();
  });

  it('strict input is not flagged recovered; junk yields a problem, never content', () => {
    const good = JSON.stringify({ reply: 'Q?', ready: false, brief: EMPTY_BRIEF });
    expect(salvageInterviewTurn(good)?.recovered).toBe(false);
    expect(interviewTurnProblem(good)).toBeNull();
    expect(salvageInterviewTurn('{"broken"')).toBeNull();
    expect(interviewTurnProblem('{"broken"')).toContain('no readable JSON');
  });

  it('bundle salvage keeps complete variants when the reply is truncated', () => {
    const variant = (n: string) =>
      `{"id":"v${n}","name":"V${n}","headline":"H${n}","body":["B${n}"],"ctaText":"Go","bannerPrompt":"p${n}"}`;
    const truncated = `{"subjects":["S1","S2","S3"],"preheader":"P","variants":[${variant('1')},${variant('2')},{"id":"v3","name":"V3","headli`;
    const read = salvageEmailBundle(truncated);
    expect(read?.recovered).toBe(true);
    expect(read?.bundle.subjects).toEqual(['S1', 'S2', 'S3']);
    expect(read?.bundle.variants.map((v) => v.headline)).toEqual(['H1', 'H2']);
    expect(emailBundleProblem(truncated)).toContain('no readable JSON');
  });

  it('refine salvage rebuilds the variant from surviving fields', () => {
    const base = { id: 'a', name: 'A', headline: 'H', body: ['B1'], ctaText: 'Go', bannerPrompt: 'p' };
    const read = salvageRefinedVariant('{"headline":"H2","body":["B2","B3"],"ctaText":"Go2","bannerPrompt":"p2"', base);
    expect(read?.recovered).toBe(true);
    expect(read?.variant).toMatchObject({ id: 'a', name: 'A', headline: 'H2', body: ['B2', 'B3'] });
  });

  it('repair body states the shape, the problem, and the malformed reply', () => {
    const body = buildRepairBody('interview', '{"broken"', 'no readable JSON object');
    const step = asStep(body);
    const messages = step.params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('repair malformed');
    expect(messages[1]?.content).toContain('Required JSON shape');
    expect(messages[1]?.content).toContain('no readable JSON object');
    expect(messages[1]?.content).toContain('{"broken"');
  });

  it('mergeBriefs never erases a known field with an empty incoming one', () => {
    const merged = mergeBriefs(BRIEF, { ...EMPTY_BRIEF });
    expect(merged.purpose).toBe(BRIEF.purpose);
    expect(merged.keyPoints).toEqual(BRIEF.keyPoints);
  });
});

describe('envelope unwrap + model selection (v0.1.4)', () => {
  it('unwraps a provider envelope to the model JSON', () => {
    const inner = JSON.stringify({ reply: 'Q?', ready: false, brief: EMPTY_BRIEF });
    const envelope = JSON.stringify({ choices: [{ message: { content: inner } }] });
    expect(parseInterviewTurn(envelope)?.reply).toBe('Q?');
    expect(salvageInterviewTurn(envelope)?.via).toBe('strict');
  });

  it('unwraps a double-encoded JSON string reply', () => {
    const inner = JSON.stringify({ reply: 'Hi there', ready: false, brief: EMPTY_BRIEF });
    expect(parseInterviewTurn(JSON.stringify(inner))?.reply).toBe('Hi there');
  });

  it('unwrapTextEnvelope leaves plain text alone', () => {
    expect(unwrapTextEnvelope('just prose')).toBe('just prose');
  });

  it('body builders thread the picked model; defaults stay on DeepSeek V4 Flash', () => {
    const body = asStep(buildInterviewBody([], 'deepseek/deepseek-chat'));
    expect(body.params.model).toBe('deepseek/deepseek-chat');
    expect(asStep(buildInterviewBody([])).params.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(asStep(buildBundleBody(BRIEF, 'openai/gpt-4o-mini')).params.model).toBe(
      'openai/gpt-4o-mini',
    );
    expect(asStep(buildRepairBody('interview', 'x', 'y', 'deepseek/deepseek-chat')).params.model).toBe(
      'deepseek/deepseek-chat',
    );
    expect(CHAT_MODELS.map((m) => m.id)).toContain('openai/gpt-4o-mini');
    expect(isChatModelId('openai/gpt-4o-mini')).toBe(true);
    expect(isChatModelId('openai/gpt-5-fake')).toBe(false);
  });
});
