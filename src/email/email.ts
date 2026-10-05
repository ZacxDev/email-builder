// Email Builder generation contracts — P0 spike (2026-10-04).
//
// Two priced primitives, both driven through the host's estimate → consent →
// submit → poll lifecycle (`useBuzzWorkflow`), exactly like every other app
// in this portfolio:
//
//  1. COPY + INTERVIEW — the host's REGISTERED `chat-completion` step
//     (`{ kind: 'step', step: 'chat-completion' }`). The model must stay on
//     the host allowlist: a fabricated model id is quoted, CHARGED, then
//     fails at execution with no refund. We use `openai/gpt-4o-mini`, the
//     same model Character Sheet Studio shipped its prompt enhancement on.
//     The reply comes back moderation-scanned on the terminal snapshot's
//     `textOutputs` (live host fields the published SDK type lags; read via
//     structural cast — the transport passes unknown fields through).
//
//  2. BANNER IMAGE — the PASS-THROUGH arm of `kind: 'step'` (`step` key
//     ABSENT, `$type` present). The block names the orchestrator step type
//     directly and the host forwards `input` unmodified, so the body below
//     is byte-for-byte the orchestration `imageGen` shape the Civitai MCP /
//     REST recipes use (developer.civitai.com/orchestration/recipes/google):
//     engine `google`, model `nano-banana-2` (Gemini 2.5 Flash Image) — the
//     docs' default for new integrations, and the only Nano Banana route
//     with aspect-ratio control, which an email banner needs. Flat pricing
//     at the time of writing: 104 Buzz per 1K image; `estimate` on a
//     pass-through body only echoes `maxBuzz` back as an upper bound, so
//     the UI must say "up to N Buzz", never quote it as the price.
//     `maxBuzz` is ALSO the step timeout in seconds (1…250), so it is sized
//     to cover the 1K price with queue headroom, not to the expected cost.
//
// No React, no DOM — unit-tested in node (see email.test.ts).

import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

// ---------------------------------------------------------------------------
// Chat (interview + copy bundle)
// ---------------------------------------------------------------------------

/** Host-allowlisted chat model — see header. Do not invent model ids. */
export const CHAT_MODEL = 'openai/gpt-4o-mini';

/** The host-allowlisted chat models the user can pick (v0.1.4). A model NOT
 *  on the allowlist gets quoted, CHARGED, then fails at execution — never
 *  offer anything outside this list. */
export const CHAT_MODELS = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash' },
  { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', label: 'Dolphin Mistral 24B' },
] as const;

export type ChatModelId = (typeof CHAT_MODELS)[number]['id'];

export function isChatModelId(value: unknown): value is ChatModelId {
  return typeof value === 'string' && CHAT_MODELS.some((m) => m.id === value);
}

/** Interview turns are short: one question, or a brief confirmation. */
export const INTERVIEW_MAX_TOKENS = 700;

/**
 * The copy bundle is one JSON document (3 subjects + 3 full variants), so
 * it needs real headroom over a single-prompt rewrite. The host's per-step
 * schema bounds maxTokens server-side; if a live submit ever BAD_REQUESTs
 * on it, lower this — the parser tolerates a truncated-then-retried bundle
 * no worse than any other unparseable reply (it returns null, caller keeps
 * the previous state).
 */
export const BUNDLE_MAX_TOKENS = 1800;

/** One turn of the in-app interview, as kept by the client. */
export type ChatTurn = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** In-chat rich card (v0.1.4): the moment a draft package is created, the
   *  conversation itself carries a draft widget the user can act on. */
  widget?: {
    type: 'draft';
    subjects: string[];
    variants: { id: string; name: string; headline: string }[];
  };
};

/** What the interview is trying to fill in before any bundle is generated. */
export type EmailBrief = {
  purpose: string;
  audience: string;
  tone: string;
  ctaText: string;
  ctaUrl: string;
  keyPoints: string[];
  senderName: string;
  bannerVibe: string;
};

export const EMPTY_BRIEF: EmailBrief = {
  purpose: '',
  audience: '',
  tone: '',
  ctaText: '',
  ctaUrl: '',
  keyPoints: [],
  senderName: '',
  bannerVibe: '',
};

const INTERVIEW_SYSTEM =
  'You are the interviewer inside an email builder app. The user describes an email in freeform chat; ' +
  'you ask ONE short question at a time to fill the brief: purpose, audience, tone, call-to-action text and link, ' +
  'must-include points, sender name, and banner image vibe. Prefer the question that unblocks generation most. ' +
  'When you know enough to write the email (purpose + audience + at least one key point), set ready=true and make ' +
  'your reply a one-paragraph summary of the brief for the user to confirm. ' +
  'Reply with ONLY a JSON object, no markdown fences, of the shape: ' +
  '{"reply": string, "ready": boolean, "brief": {"purpose": string, "audience": string, "tone": string, ' +
  '"ctaText": string, "ctaUrl": string, "keyPoints": string[], "senderName": string, "bannerVibe": string}}. ' +
  'Carry forward everything learned so far in the brief on every turn; use "" / [] for anything still unknown.';

/**
 * One interview turn. The client owns the transcript and replays it; the
 * brief the model returns each turn replaces the client's copy wholesale
 * (the model is instructed to carry prior facts forward).
 */
const INTERVIEW_EXEMPLARS: ChatTurn[] = [
  {
    role: 'user',
    content: 'I want to email our beta users about the new dark mode.',
  },
  {
    role: 'assistant',
    content:
      '{"reply":"Dark mode for your beta users — noted. Should the email push them to try it right away, and is there a link I should send them to?","ready":false,"brief":{"purpose":"Announce the new dark mode","audience":"beta users","tone":"","ctaText":"","ctaUrl":"","keyPoints":["new dark mode feature"],"senderName":"","bannerVibe":""}}',
  },
];

export function buildInterviewBody(
  transcript: readonly ChatTurn[],
  model: ChatModelId = CHAT_MODEL,
): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model,
      maxTokens: INTERVIEW_MAX_TOKENS,
      messages: [
        { role: 'system', content: INTERVIEW_SYSTEM },
        ...INTERVIEW_EXEMPLARS,
        ...transcript,
      ],
    },
  };
}

const BUNDLE_SYSTEM =
  'You write email packages. Given a brief, return ONLY a JSON object, no markdown fences, of the shape: ' +
  '{"subjects": string[3], "preheader": string, "variants": [{"id": string, "name": string, "headline": string, ' +
  '"body": string[], "ctaText": string, "bannerPrompt": string}]}. ' +
  'Exactly 3 subject options (each under 60 characters) and exactly 3 template variants that differ in angle and ' +
  'layout feel (e.g. announcement, story-led, minimal). Each variant body is 2-4 short paragraphs. bannerPrompt is a ' +
  'vivid, text-free banner image description in the variant\'s visual direction — banners never contain words. ' +
  'Use the brief\'s CTA text and link intent; never invent prices, dates, or links that are not in the brief.';

/** The paid bundle: subjects + preheader + 3 copy/layout variants. */
export function buildBundleBody(brief: EmailBrief, model: ChatModelId = CHAT_MODEL): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model,
      maxTokens: BUNDLE_MAX_TOKENS,
      messages: [
        { role: 'system', content: BUNDLE_SYSTEM },
        {
          role: 'user',
          content:
            '{"purpose":"Announce dark mode","audience":"beta users","tone":"friendly","ctaText":"Try it now","ctaUrl":"","keyPoints":["new dark mode"],"senderName":"App Team","bannerVibe":"sleek dark interface"}',
        },
        {
          role: 'assistant',
          content:
            '{"subjects":["Dark mode is here","Your eyes will thank you","New: dark mode"],"preheader":"Flip it on in Settings.","variants":[{"id":"announcement","name":"Announcement","headline":"Dark mode has landed","body":["Our most-requested feature is live: dark mode, across the whole app.","Open Settings and flip it on — it takes five seconds."],"ctaText":"Try it now","bannerPrompt":"sleek dark app interface glowing softly on a desk at night, moody, no text"},{"id":"story","name":"Story-led","headline":"Built for late-night sessions","body":["You asked for it after every late-night session.","Dark mode is now one tap away."],"ctaText":"Try it now","bannerPrompt":"person using a phone in a dim room, warm lamp light, no text"},{"id":"minimal","name":"Minimal","headline":"Dark mode.","body":["It is here.","Settings → Appearance → Dark."],"ctaText":"Try it now","bannerPrompt":"minimal dark gradient with a single soft light streak, abstract, no text"}]}',
        },
        { role: 'user', content: JSON.stringify(brief) },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Banner image (pass-through imageGen)
// ---------------------------------------------------------------------------

/** Orchestrator step type for image generation (MCP `run_step` stepType). */
export const BANNER_STEP_TYPE = 'imageGen';

/** Google engine — the Nano Banana route with aspect-ratio control. */
export const BANNER_ENGINE = 'google';

/** Gemini 2.5 Flash Image, next-gen — docs' default for new integrations. */
export const BANNER_MODEL = 'nano-banana-2';

/** Cheaper/faster fallback (Gemini 3.1 Flash-Lite Image, 1K only, 44 Buzz). */
export const BANNER_MODEL_LITE = 'nano-banana-2-lite';

/** Wide banner framing; the preview/export crops to the email's 3:1 slot. */
export const BANNER_ASPECT_RATIO = '16:9';

/** 1K tier — flat 104 Buzz/image for nano-banana-2 at the time of writing. */
export const BANNER_RESOLUTION = '1K';

/**
 * Pass-through ceiling AND timeout: 150 covers the 104 Buzz 1K price and
 * gives the step 150 s of wall clock (typical 8–20 s). Must stay ≤ the
 * manifest's buzzBudgetPerGen (300) or the host refuses before submit.
 */
export const BANNER_MAX_BUZZ = 150;

/**
 * The banner body. 🔴 There is deliberately NO `step` key — its absence is
 * the arm discriminator; adding one routes the body to the registry arm,
 * which rejects `imageGen` fail-closed. The `input` object is forwarded to
 * the orchestrator unmodified, so it mirrors the google recipe exactly.
 */
export function buildBannerBody(
  bannerPrompt: string,
  opts?: { model?: string; aspectRatio?: string },
): WorkflowBody {
  return {
    kind: 'step',
    $type: BANNER_STEP_TYPE,
    input: {
      engine: BANNER_ENGINE,
      model: opts?.model ?? BANNER_MODEL,
      prompt: bannerPrompt.trim(),
      aspectRatio: opts?.aspectRatio ?? BANNER_ASPECT_RATIO,
      resolution: BANNER_RESOLUTION,
      numImages: 1,
    },
    maxBuzz: BANNER_MAX_BUZZ,
  };
}

// ---------------------------------------------------------------------------
// Snapshot readers
// ---------------------------------------------------------------------------

/** What a terminal chat snapshot gave back. */
export type TextOutcome =
  | { type: 'text'; text: string }
  | { type: 'withheld'; reason: string }
  | { type: 'none' };

/**
 * Read a chat reply out of a terminal snapshot. `textOutputs` carries the
 * released (scanned) reply; `textOutputWithheld` carries a user-facing
 * reason when text was produced but kept back. Anything else is `none`
 * and callers keep their previous state. (Same reader Character Sheet
 * Studio shipped for prompt enhancement.)
 */
export function textOutcomeFromSnapshot(snap: BlockWorkflowSnapshot): TextOutcome {
  const ext = snap as BlockWorkflowSnapshot & {
    textOutputs?: unknown;
    textOutputWithheld?: { reason?: unknown } | null;
  };
  if (Array.isArray(ext.textOutputs)) {
    const text = ext.textOutputs.find(
      (t): t is string => typeof t === 'string' && t.trim() !== '',
    );
    if (text) return { type: 'text', text: text.trim() };
  }
  const reason = ext.textOutputWithheld?.reason;
  if (typeof reason === 'string' && reason.trim() !== '') {
    return { type: 'withheld', reason: reason.trim() };
  }
  return { type: 'none' };
}

/** First displayable image URL from a succeeded banner snapshot, if any. */
export function bannerUrlFromSnapshot(snap: BlockWorkflowSnapshot | null): string | null {
  if (!snap || !snap.imageUrls || snap.imageUrls.length === 0) return null;
  return snap.imageUrls[0] ?? null;
}

// ---------------------------------------------------------------------------
// JSON parsing — the model is told to return bare JSON; tolerate fences and
// surrounding prose, but never fabricate: unparseable → null.
// ---------------------------------------------------------------------------

/**
 * Unwrap provider envelopes / double-encoded replies: a JSON string literal
 * wrapping the payload, or a chat-completion envelope whose
 * choices[0].message.content carries it. Returns the innermost text.
 */
export function unwrapTextEnvelope(text: string): string {
  let t = text.replace(/^\uFEFF/, '').trim();
  for (let i = 0; i < 3; i++) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      break;
    }
    if (typeof v === 'string') {
      t = v.trim();
      continue;
    }
    if (typeof v === 'object' && v !== null) {
      const choices = (v as { choices?: unknown }).choices;
      if (Array.isArray(choices)) {
        const first = choices[0] as
          | { message?: { content?: unknown }; text?: unknown }
          | undefined;
        const inner = first?.message?.content ?? first?.text;
        if (typeof inner === 'string') {
          t = inner.trim();
          continue;
        }
      }
    }
    break;
  }
  return t;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let candidate = unwrapTextEnvelope(text);
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidate = fenced[1].trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Normalize a model-returned brief; missing fields stay empty, never guessed. */
export function normalizeBrief(value: unknown): EmailBrief {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_BRIEF };
  const v = value as Record<string, unknown>;
  return {
    purpose: asString(v.purpose),
    audience: asString(v.audience),
    tone: asString(v.tone),
    ctaText: asString(v.ctaText),
    ctaUrl: asString(v.ctaUrl),
    keyPoints: asStringList(v.keyPoints, 8),
    senderName: asString(v.senderName),
    bannerVibe: asString(v.bannerVibe),
  };
}

/** A brief is generatable once purpose + audience + one key point exist. */
export function briefIsReady(brief: EmailBrief): boolean {
  return brief.purpose !== '' && brief.audience !== '' && brief.keyPoints.length > 0;
}

export type InterviewTurnResult = { reply: string; ready: boolean; brief: EmailBrief };

/** Parse one interview reply. Null when the model ignored the JSON contract. */
export function parseInterviewTurn(text: string): InterviewTurnResult | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const reply = asString(obj.reply);
  if (!reply) return null;
  const brief = normalizeBrief(obj.brief);
  return { reply, ready: obj.ready === true && briefIsReady(brief), brief };
}

// ---------------------------------------------------------------------------
// Salvage + repair (v0.1.3) — a charged turn should never die on shape alone.
//
// Production evidence (2026-10-04): a real interview reply arrived in a shape
// the strict parser rejected, and the user paid 1 Buzz for a dead turn. The
// pipeline now is: strict parse → tolerant field-level salvage (recovers the
// model's OWN words from fenced/truncated/wrong-typed JSON, never invents) →
// one repair generation that re-asks with the problem stated. Salvage costs
// nothing; the repair is disclosed on the price-confirm card.
// ---------------------------------------------------------------------------

/** Merge a model-carried brief over the client's: empty incoming fields keep
 *  what the client already knew (protects state on salvaged prose turns). */
export function mergeBriefs(base: EmailBrief, next: EmailBrief): EmailBrief {
  return {
    purpose: next.purpose || base.purpose,
    audience: next.audience || base.audience,
    tone: next.tone || base.tone,
    ctaText: next.ctaText || base.ctaText,
    ctaUrl: next.ctaUrl || base.ctaUrl,
    keyPoints: next.keyPoints.length > 0 ? next.keyPoints : base.keyPoints,
    senderName: next.senderName || base.senderName,
    bannerVibe: next.bannerVibe || base.bannerVibe,
  };
}

/** Extract one `"field": "..."` string from JSON-ish text, escape-aware. */
function extractStringField(text: string, field: string): string {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m?.[1]) return '';
  try {
    return (JSON.parse(`"${m[1]}"`) as string).trim();
  } catch {
    return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  }
}

/** Extract `"field": ["...", ...]` string items from JSON-ish text. */
function extractStringArrayField(text: string, field: string, cap: number): string[] {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!m?.[1]) return [];
  const out: string[] = [];
  for (const sm of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const v = extractStringField(`"x":"${sm[1]}"`, 'x') || sm[1];
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/** Why the strict interview parse rejected this text (for the repair ask). */
export function interviewTurnProblem(text: string): string | null {
  if (parseInterviewTurn(text)) return null;
  if (!parseJsonObject(text)) return 'the reply contained no readable JSON object';
  return 'the "reply" field was empty or missing';
}

/**
 * Strict parse, then tolerant salvage. `recovered: true` means the model's
 * words were rescued from a messy shape (fences, truncation, partial JSON,
 * or plain prose instead of JSON). Null only when nothing readable exists.
 */
export function salvageInterviewTurn(
  text: string,
): { result: InterviewTurnResult; recovered: boolean; via: 'strict' | 'fields' | 'prose' } | null {
  const strict = parseInterviewTurn(text);
  if (strict) return { result: strict, recovered: false, via: 'strict' };

  const reply = extractStringField(text, 'reply');
  if (reply) {
    const brief = normalizeBrief({
      purpose: extractStringField(text, 'purpose'),
      audience: extractStringField(text, 'audience'),
      tone: extractStringField(text, 'tone'),
      ctaText: extractStringField(text, 'ctaText'),
      ctaUrl: extractStringField(text, 'ctaUrl'),
      keyPoints: extractStringArrayField(text, 'keyPoints', 8),
      senderName: extractStringField(text, 'senderName'),
      bannerVibe: extractStringField(text, 'bannerVibe'),
    });
    return {
      result: {
        reply,
        ready: /"ready"\s*:\s*true/.test(text) && briefIsReady(brief),
        brief,
      },
      recovered: true,
      via: 'fields',
    };
  }

  // Plain prose instead of JSON: still the answer the user paid for.
  const prose = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .trim();
  if (prose && !prose.startsWith('{') && prose.length >= 8) {
    return {
      result: { reply: prose.slice(0, 2000), ready: false, brief: { ...EMPTY_BRIEF } },
      recovered: true,
      via: 'prose',
    };
  }
  return null;
}

/** Why the strict bundle parse rejected this text. */
export function emailBundleProblem(text: string): string | null {
  if (parseEmailBundle(text)) return null;
  if (!parseJsonObject(text)) return 'the reply contained no readable JSON object';
  return 'no usable subject options or template variants were found';
}

/** Split the objects inside a `"variants": [...]` array, brace-aware. */
function extractVariantChunks(text: string): string[] {
  const at = text.indexOf('"variants"');
  if (at === -1) return [];
  const open = text.indexOf('[', at);
  if (open === -1) return [];
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, i + 1));
        start = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return chunks;
}

/** Bundle salvage: rescue complete variants from a truncated/messy reply. */
export function salvageEmailBundle(
  text: string,
): { bundle: EmailBundle; recovered: boolean } | null {
  const strict = parseEmailBundle(text);
  if (strict) return { bundle: strict, recovered: false };

  const subjects = extractStringArrayField(text, 'subjects', 3);
  const variants = extractVariantChunks(text)
    .map((chunk, i) => {
      const parsed = parseJsonObject(chunk);
      if (parsed) return normalizeVariant(parsed, i);
      return normalizeVariant(
        {
          name: extractStringField(chunk, 'name'),
          headline: extractStringField(chunk, 'headline'),
          body: extractStringArrayField(chunk, 'body', 6),
          ctaText: extractStringField(chunk, 'ctaText'),
          bannerPrompt: extractStringField(chunk, 'bannerPrompt'),
        },
        i,
      );
    })
    .filter((v): v is EmailVariant => v !== null)
    .slice(0, 3);
  if (subjects.length === 0 || variants.length === 0) return null;
  return {
    bundle: { subjects, preheader: extractStringField(text, 'preheader'), variants },
    recovered: true,
  };
}

/** Why the strict refine parse rejected this text. */
export function refinedVariantProblem(text: string, base: EmailVariant): string | null {
  if (parseRefinedVariant(text, base)) return null;
  if (!parseJsonObject(text)) return 'the reply contained no readable JSON object';
  return 'the revised headline or body was empty';
}

/** Refine salvage: rebuild the variant from whatever fields survived. */
export function salvageRefinedVariant(
  text: string,
  base: EmailVariant,
): { variant: EmailVariant; recovered: boolean } | null {
  const strict = parseRefinedVariant(text, base);
  if (strict) return { variant: strict, recovered: false };
  const merged = normalizeVariant(
    {
      headline: extractStringField(text, 'headline'),
      body: extractStringArrayField(text, 'body', 6),
      ctaText: extractStringField(text, 'ctaText'),
      bannerPrompt: extractStringField(text, 'bannerPrompt'),
      id: base.id,
      name: base.name,
    },
    0,
  );
  return merged ? { variant: merged, recovered: true } : null;
}

export type RepairKind = 'interview' | 'bundle' | 'refine';

const REPAIR_SHAPES: Record<RepairKind, string> = {
  interview:
    '{"reply": string, "ready": boolean, "brief": {"purpose": string, "audience": string, "tone": string, "ctaText": string, "ctaUrl": string, "keyPoints": string[], "senderName": string, "bannerVibe": string}}',
  bundle:
    '{"subjects": string[3], "preheader": string, "variants": [{"id": string, "name": string, "headline": string, "body": string[], "ctaText": string, "bannerPrompt": string}]}',
  refine: '{"headline": string, "body": string[], "ctaText": string, "bannerPrompt": string}',
};

const REPAIR_MAX_TOKENS: Record<RepairKind, number> = {
  interview: 700,
  bundle: 1800,
  refine: 900,
};

const REPAIR_SYSTEM =
  'You repair malformed model output. You are given a required JSON shape, the problem found in a ' +
  'previous reply, and that reply. Return ONLY the corrected JSON object — no markdown fences, no ' +
  'commentary. Preserve the original content and wording wherever it fits the shape; never invent ' +
  'facts that were not in the reply.';

/** The one repair generation: re-ask with the concrete problem stated. */
export function buildRepairBody(
  kind: RepairKind,
  rawText: string,
  problem: string,
  model: ChatModelId = CHAT_MODEL,
): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model,
      maxTokens: REPAIR_MAX_TOKENS[kind],
      messages: [
        { role: 'system', content: REPAIR_SYSTEM },
        {
          role: 'user',
          content:
            `Required JSON shape: ${REPAIR_SHAPES[kind]}\n` +
            `Problem found in the previous reply: ${problem}\n` +
            `Previous reply to repair:\n${rawText.slice(0, 6000)}`,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Shared money-path helpers
// ---------------------------------------------------------------------------

/** Snapshot statuses that mean "stop polling". */
export function isTerminalStatus(status: BlockWorkflowSnapshot['status']): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'canceled'
  );
}

/** The scope the page token must carry before a priced step can be submitted. */
export const BUDGETED_SCOPE = 'ai:write:budgeted';

/** True when the block token already carries the budgeted scope. */
export function hasBudgetedScope(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(BUDGETED_SCOPE);
}

/** Human Buzz cost, e.g. 8 → "8 Buzz". Unknown → em dash. */
export function formatBuzz(cost: number | null | undefined): string {
  return typeof cost === 'number' && Number.isFinite(cost) ? `${cost} Buzz` : '—';
}

/**
 * Stable idempotency key for one logical submit. The host rejects anything
 * outside `^[A-Za-z0-9_-]{1,64}$` (NO colons — it composes its dedupe key
 * with them), so the seed is FNV-1a hashed instead of concatenated raw.
 * Reusing the same key on a retry collapses to ONE charge.
 */
export function idempotencyKeyFor(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return `k-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Refinement — chat-driven iteration on one variant after the bundle
// ---------------------------------------------------------------------------

/** A refinement rewrites one variant, so it needs less headroom than a bundle. */
export const REFINE_MAX_TOKENS = 900;

const REFINE_SYSTEM =
  'You revise ONE email variant. Given the current variant JSON, the brief, and a revision instruction, ' +
  'return ONLY a JSON object, no markdown fences, of the shape: {"headline": string, "body": string[], ' +
  '"ctaText": string, "bannerPrompt": string}. Apply the instruction faithfully and keep everything else ' +
  'about the variant (angle, facts, CTA link intent) unless the instruction says otherwise. Body stays 2-4 ' +
  'short paragraphs. bannerPrompt stays a vivid, text-free image description.';

/** The paid refinement of the selected variant from a chat instruction. */
export function buildRefineBody(
  variant: EmailVariant,
  instruction: string,
  brief: EmailBrief,
  model: ChatModelId = CHAT_MODEL,
): WorkflowBody {
  return {
    kind: 'step',
    step: 'chat-completion',
    params: {
      model,
      maxTokens: REFINE_MAX_TOKENS,
      messages: [
        { role: 'system', content: REFINE_SYSTEM },
        {
          role: 'user',
          content:
            '{"brief":{"purpose":"Announce dark mode","audience":"beta users"},"variant":{"id":"announcement","name":"Announcement","headline":"Dark mode has landed","body":["Our most-requested feature is live.","Open Settings and flip it on."],"ctaText":"Try it now","bannerPrompt":"sleek dark interface, no text"},"instruction":"make the headline punchier"}',
        },
        {
          role: 'assistant',
          content:
            '{"headline":"Your eyes called — dark mode answered","body":["Our most-requested feature is live.","Open Settings and flip it on."],"ctaText":"Try it now","bannerPrompt":"sleek dark interface, no text"}',
        },
        {
          role: 'user',
          content: JSON.stringify({ brief, variant, instruction: instruction.trim() }),
        },
      ],
    },
  };
}

/** Parse a refined variant, keeping the original id/name. Null on junk. */
export function parseRefinedVariant(text: string, base: EmailVariant): EmailVariant | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const merged = normalizeVariant({ ...obj, id: base.id, name: base.name }, 0);
  return merged;
}

/** Replace one variant in a list (pure — the UI state transition). */
export function replaceVariant(
  variants: readonly EmailVariant[],
  updated: EmailVariant,
): EmailVariant[] {
  return variants.map((v) => (v.id === updated.id ? updated : v));
}

// ---------------------------------------------------------------------------
// The generated bundle + draft model (storage shape for drafts/templates)
// ---------------------------------------------------------------------------

export type EmailVariant = {
  id: string;
  name: string;
  headline: string;
  body: string[];
  ctaText: string;
  bannerPrompt: string;
};

export type EmailBundle = {
  subjects: string[];
  preheader: string;
  variants: EmailVariant[];
};

function normalizeVariant(value: unknown, index: number): EmailVariant | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const headline = asString(v.headline);
  const body = asStringList(v.body, 6);
  if (!headline || body.length === 0) return null;
  return {
    id: asString(v.id) || `variant-${index + 1}`,
    name: asString(v.name) || `Variant ${index + 1}`,
    headline,
    body,
    ctaText: asString(v.ctaText),
    bannerPrompt: asString(v.bannerPrompt),
  };
}

/** Parse the bundle. Caps at 3 subjects / 3 variants; junk variants drop. */
export function parseEmailBundle(text: string): EmailBundle | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const subjects = asStringList(obj.subjects, 3);
  const rawVariants = Array.isArray(obj.variants) ? obj.variants : [];
  const variants = rawVariants
    .map((v, i) => normalizeVariant(v, i))
    .filter((v): v is EmailVariant => v !== null)
    .slice(0, 3);
  if (subjects.length === 0 || variants.length === 0) return null;
  return { subjects, preheader: asString(obj.preheader), variants };
}

/** One saved draft/template — the per-viewer storage row shape. */
export type EmailDraft = {
  id: string;
  name: string;
  brief: EmailBrief;
  subjects: string[];
  preheader: string;
  variants: EmailVariant[];
  selectedVariantId: string;
  bannerUrl: string;
  /** Resumability anchor: banner blob URLs are signed and expire, so the
   *  workflow id (plus the variant's bannerPrompt) is what a draft keeps to
   *  re-read or regenerate the banner later. */
  bannerWorkflowId: string;
  /** The interview/refine conversation, so a reopened draft keeps its chat. */
  transcript: ChatTurn[];
  updatedAt: string;
};

/** A fresh, empty draft (the "New email" state). */
export function newDraft(id: string, nowIso: string): EmailDraft {
  return {
    id,
    name: 'Untitled email',
    brief: { ...EMPTY_BRIEF },
    subjects: [],
    preheader: '',
    variants: [],
    selectedVariantId: '',
    bannerUrl: '',
    bannerWorkflowId: '',
    transcript: [],
    updatedAt: nowIso,
  };
}

/** Coerce persisted chat turns; caps history so a draft stays a small row. */
export function normalizeTranscript(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const out: ChatTurn[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    const role = t.role;
    const content = asString(t.content);
    if ((role === 'user' || role === 'assistant' || role === 'system') && content) {
      const turn: ChatTurn = { role, content };
      const w = t.widget as { type?: unknown; subjects?: unknown; variants?: unknown } | undefined;
      if (w && w.type === 'draft' && Array.isArray(w.variants)) {
        turn.widget = {
          type: 'draft',
          subjects: asStringList(w.subjects, 3),
          variants: w.variants
            .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
            .map((v) => ({
              id: asString(v.id),
              name: asString(v.name),
              headline: asString(v.headline),
            }))
            .filter((v) => v.id !== '')
            .slice(0, 3),
        };
      }
      out.push(turn);
    }
    if (out.length >= 60) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export — responsive, table-based HTML with inline CSS (what real email
// clients accept). No sending in v1; this is the copy/download deliverable.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Download filename for an exported email, e.g. "Spring Launch!" → "spring-launch.html". */
export function emailExportFilename(draftName: string): string {
  const slug = draftName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'email'}.html`;
}

/** Build the exportable HTML document for one variant of a draft. */
export function buildEmailHtml(draft: EmailDraft, variant: EmailVariant, subject: string): string {
  const ctaUrl = draft.brief.ctaUrl || '#';
  const banner = draft.bannerUrl
    ? `<tr><td style="padding:0"><img src="${escapeHtml(draft.bannerUrl)}" alt="" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>`
    : '';
  const paras = variant.body
    .map(
      (p) =>
        `<tr><td style="padding:0 32px 16px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#26282c">${escapeHtml(p)}</td></tr>`,
    )
    .join('\n');
  const signoff = draft.brief.senderName
    ? `<tr><td style="padding:8px 32px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#5c5f66">— ${escapeHtml(draft.brief.senderName)}</td></tr>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
${banner}
<tr><td style="padding:28px 32px 12px;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.25;font-weight:700;color:#17181a">${escapeHtml(variant.headline)}</td></tr>
${paras}
<tr><td align="left" style="padding:8px 32px 28px"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#1971c2;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:6px">${escapeHtml(variant.ctaText || draft.brief.ctaText || 'Learn more')}</a></td></tr>
${signoff}
</table>
</td></tr></table>
</body></html>`;
}

/** Storage round-trip guard: coerce unknown persisted JSON into a draft. */
export function normalizeDraft(value: unknown): EmailDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = asString(v.id);
  if (!id) return null;
  const rawVariants = Array.isArray(v.variants) ? v.variants : [];
  const variants = rawVariants
    .map((x, i) => normalizeVariant(x, i))
    .filter((x): x is EmailVariant => x !== null)
    .slice(0, 3);
  const selected = asString(v.selectedVariantId);
  return {
    id,
    name: asString(v.name) || 'Untitled email',
    brief: normalizeBrief(v.brief),
    subjects: asStringList(v.subjects, 3),
    preheader: asString(v.preheader),
    variants,
    selectedVariantId: variants.some((x) => x.id === selected)
      ? selected
      : (variants[0]?.id ?? ''),
    bannerUrl: asString(v.bannerUrl),
    bannerWorkflowId: asString(v.bannerWorkflowId),
    transcript: normalizeTranscript(v.transcript),
    updatedAt: asString(v.updatedAt),
  };
}
