// Email Builder — P1 builder core.
//
// One screen, two columns (stacked when narrow):
//   left  — the interview chat (freeform), the brief it builds, your drafts
//   right — variant picker, live email preview (desktop/mobile width),
//           manual tweaks, banner generation, export
//
// Money discipline (portfolio-wide): every priced action — an interview turn,
// the copy bundle, a chat refinement, a banner image — is estimated first and
// parked behind an explicit confirm showing the price. Nothing submits on a
// click that didn't show a number first. Banner estimates are a CAP ("up to
// 150 Buzz"), because a pass-through step's estimate only echoes maxBuzz.
// Consent comes before pricing (the production host scope-gates estimate
// itself): a missing scope parks the action and auto-resumes on the grant.
//
// Drafts persist via useAppStorage (best-effort: a failed save is surfaced,
// never silently lost — the work stays on screen).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import {
  useBlockBreakpoint,
  useBlockContext,
  useBlockResize,
  useBlockToken,
  useBuzzWorkflow,
  useConsentUnavailable,
  useRequestConsent,
  useRequestSignIn,
} from '@civitai/blocks-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  SegmentedControl,
  Stack,
  TextInput,
  Textarea,
  injectBlocksStyles,
} from '@civitai/blocks-react/ui';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import {
  BANNER_MAX_BUZZ,
  bannerUrlFromSnapshot,
  briefIsReady,
  buildBannerBody,
  buildBundleBody,
  buildEmailHtml,
  emailExportFilename,
  buildInterviewBody,
  buildRefineBody,
  formatBuzz,
  hasBudgetedScope,
  idempotencyKeyFor,
  newDraft,
  buildRepairBody,
  CHAT_MODEL,
  CHAT_MODELS,
  isChatModelId,
  type ChatModelId,
  emailBundleProblem,
  interviewTurnProblem,
  mergeBriefs,
  refinedVariantProblem,
  salvageEmailBundle,
  salvageInterviewTurn,
  salvageRefinedVariant,
  replaceVariant,
  textOutcomeFromSnapshot,
  type ChatTurn,
  type EmailDraft,
  type EmailVariant,
} from './email/email.js';
import { runToTerminal } from './email/money.js';
import { storeErrorMessage } from './email/store.js';
import { useEmailDrafts } from './email/useEmailDrafts.js';
import { CORAL_POST_LIGHT, DEFAULT_PALETTE, paletteById } from './palettes.js';

injectBlocksStyles();

type Phase = 'idle' | 'needs-consent' | 'estimating' | 'confirming' | 'working';

type ActionKind = 'interview' | 'bundle' | 'refine' | 'banner';

interface PendingConfirm {
  kind: ActionKind;
  label: string;
  cost: number | null;
  /** Banner: the estimate is the maxBuzz ceiling, not a price. */
  costIsCap: boolean;
  body: WorkflowBody;
  key: string;
  /** Chat-shaped actions: one disclosed automatic repair retry may follow. */
  repairNote?: boolean;
  onSuccess: (snap: BlockWorkflowSnapshot) => void | Promise<void>;
}

const GREETING: ChatTurn = {
  role: 'assistant',
  content:
    "Tell me about the email you want to send — what it's for, who it's going to, and anything it has to include. I'll ask follow-ups until the brief is ready.",
};

function freshDraft(): EmailDraft {
  const id = `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const d = newDraft(id, new Date().toISOString());
  return { ...d, transcript: [GREETING] };
}

/** Dev-harness-only demo state (?seed=demo) so screenshots show a finished email. */
function demoDraft(): EmailDraft {
  const svg =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='675'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#1971c2'/><stop offset='1' stop-color='#e8590c'/></linearGradient></defs><rect width='1200' height='675' fill='url(#g)'/><text x='60' y='360' font-family='Arial' font-size='72' font-weight='700' fill='white'>Spring Launch</text></svg>`,
    );
  const d = freshDraft();
  return {
    ...d,
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
    subjects: ['V2 is here — your photos, upgraded', 'Spring launch: AI background removal is live'],
    preheader: 'Background removal + 2x faster exports, free to try',
    variants: [
      {
        id: 'variant-1',
        name: 'Announcement',
        headline: 'PhotoApp v2 is live',
        body: [
          'Our biggest update yet just landed: AI background removal that actually keeps the edges clean, and exports that finish twice as fast.',
          'Open the app and try it on any photo — no new downloads, no settings to learn.',
        ],
        ctaText: 'Try v2 free',
        bannerPrompt: 'bright studio photo of a phone showing a before/after edit, spring light, no text',
      },
      {
        id: 'variant-2',
        name: 'Minimal',
        headline: 'Less editing. More photo.',
        body: ['Background removal and 2x exports. That is the whole email.'],
        ctaText: 'Try v2 free',
        bannerPrompt: 'minimal product banner, soft gradient, single phone, no text',
      },
    ],
    selectedVariantId: 'variant-1',
    bannerUrl: svg,
    transcript: [
      GREETING,
      { role: 'user', content: 'Announce our spring v2 launch to free users' },
      {
        role: 'assistant',
        content: 'Here is your brief: a v2 launch email for existing free users. Look right?',
      },
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
  };
}

const isSeedDemo =
  import.meta.env.VITE_DEV_HARNESS === 'true' &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('seed') === 'demo';

/** Honest charge note for a run that completed but produced nothing usable. */
function chargeSuffix(snap: BlockWorkflowSnapshot): string {
  const total = snap.cost?.total;
  return typeof total === 'number' && total > 0
    ? ` This attempt cost ${formatBuzz(total)}.`
    : ' This attempt was charged — your Buzz history shows the exact amount.';
}

/** Charge line after a salvage failure AND a failed repair (two tries). */
function combinedChargeSuffix(snaps: BlockWorkflowSnapshot[]): string {
  let total = 0;
  let known = true;
  for (const s of snaps) {
    const c = s.cost?.total;
    if (typeof c === 'number' && Number.isFinite(c)) total += c;
    else known = false;
  }
  if (known && total > 0)
    return ` This attempt cost ${total} Buzz over ${snaps.length} tries.`;
  if (known) return '';
  return ' Check your Buzz history for what the attempts cost.';
}

/** Dev aid: keep the last raw model reply reachable for shape debugging. */
function stashRawReply(text: string): void {
  try {
    (window as unknown as Record<string, unknown>).__ebLastRawReply = text;
  } catch {
    /* dev aid only */
  }
}

export function App() {
  // Theme exploration (v0.1.2 proposals): ?palette=<id> previews a custom
  // palette in the harness. The picked palette becomes the shipped default.
  const palette = useMemo(
    () =>
      paletteById(
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('palette')
          : null,
      ) ?? DEFAULT_PALETTE,
    [],
  );

  const { ready, viewer, theme } = useBlockContext();
  const token = useBlockToken();
  const { estimate, submit, poll } = useBuzzWorkflow();
  const { requestConsent } = useRequestConsent();
  const { refusal } = useConsentUnavailable();
  const { requestSignIn } = useRequestSignIn();
  const draftsLib = useEmailDrafts();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);
  const bp = useBlockBreakpoint(rootRef);
  const narrow = bp.below('sm');

  const anon = ready && !viewer;
  const granted = hasBudgetedScope(token.scopes);
  // Read by async/parked callbacks: a closure captured before a consent grant
  // would still see the old `granted === false` and re-request forever.
  const grantedRef = useRef(granted);
  grantedRef.current = granted;

  const [draft, setDraft] = useState<EmailDraft>(() => (isSeedDemo ? demoDraft() : freshDraft()));
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Kit styles settle a beat after mount; scroll now and on the next frame
    // so the newest turn (incl. the draft widget) is what the user sees.
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, draft.transcript.length]);
  // Chat model picker (v0.1.4): allowlisted models only, remembered locally.
  const [chatModel, setChatModel] = useState<ChatModelId>(() => {
    try {
      const v = window.localStorage.getItem('eb:chat-model');
      return isChatModelId(v) ? v : CHAT_MODEL;
    } catch {
      return CHAT_MODEL;
    }
  });
  const pickModel = useCallback((id: ChatModelId) => {
    setChatModel(id);
    try {
      window.localStorage.setItem('eb:chat-model', id);
    } catch {
      /* preference is a nicety, not state */
    }
  }, []);
  // A one-tap repair offer after an unreadable chat reply (v0.1.4).
  const [repairOffer, setRepairOffer] = useState<{ run: () => Promise<void> } | null>(null);
  const [notice, setNoticeRaw] = useState<string | null>(null);
  // Success feedback channel: transient, and mutually exclusive with the
  // error notice — a fresh success clears a stale error and vice versa
  // (usability P1.1: successes were silent, failures were permanent).
  const [flash, setFlashRaw] = useState<string | null>(null);
  const setNotice = useCallback((msg: string | null) => {
    setFlashRaw(null);
    setNoticeRaw(msg);
  }, []);
  const showFlash = useCallback((msg: string) => {
    setNoticeRaw(null);
    setFlashRaw(msg);
  }, []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlashRaw(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);
  // Usability P1.3: the price-confirm must meet the user at the action, not
  // wait at the top of a 2,000px page — sticky + scroll it into view.
  useEffect(() => {
    if (pending && phase === 'confirming') {
      confirmRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }, [pending, phase]);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [subjectIdx, setSubjectIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [bannerBroken, setBannerBroken] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteArmId, setDeleteArmId] = useState<string | null>(null);

  const parkedRef = useRef<(() => void) | null>(null);
  const pollDepsRef = useRef({ submit, poll });
  pollDepsRef.current = { submit, poll };

  const selectedVariant: EmailVariant | null = useMemo(
    () => draft.variants.find((v) => v.id === draft.selectedVariantId) ?? draft.variants[0] ?? null,
    [draft.variants, draft.selectedVariantId],
  );

  // A fresh banner URL (or a variant switch) gets a fresh load attempt.
  useEffect(() => {
    setBannerBroken(false);
  }, [draft.bannerUrl, selectedVariant?.id]);
  const hasBundle = draft.variants.length > 0;
  const busy = phase === 'estimating' || phase === 'working';

  // --- draft mutation + persistence ---------------------------------------

  const persist = useCallback(
    async (d: EmailDraft, opts?: { announce?: boolean }) => {
      const stamped = { ...d, updatedAt: new Date().toISOString() };
      setDraft(stamped);
      const err = await draftsLib.saveDraft(stamped);
      setStorageNotice(err ? storeErrorMessage(err) : null);
      if (!err && opts?.announce) showFlash(`Saved “${stamped.name}”.`);
      return stamped;
    },
    [draftsLib, showFlash],
  );

  // Latest draft for async completions (a priced action resolves after the
  // render that started it). Money callbacks compute their next draft from
  // here and set it directly — never a setState inside a state updater.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveOnly = useCallback(
    async (d: EmailDraft) => {
      const err = await draftsLib.saveDraft({ ...d, updatedAt: new Date().toISOString() });
      setStorageNotice(err ? storeErrorMessage(err) : null);
    },
    [draftsLib],
  );

  const loadDraft = useCallback((d: EmailDraft) => {
    setDraft(d);
    setSubjectIdx(0);
    setPending(null);
    setPhase('idle');
    setNotice(null);
  }, []);

  const startNew = useCallback(() => {
    setDraft(freshDraft());
    setSubjectIdx(0);
    setPending(null);
    setPhase('idle');
    setNotice(null);
  }, []);

  const commitRename = useCallback(
    async (id: string) => {
      const err = await draftsLib.renameDraft(id, renameValue);
      setStorageNotice(err ? storeErrorMessage(err) : null);
      setRenamingId(null);
      // If the renamed draft is the one open, mirror the new name in the editor.
      setDraft((d) => (d.id === id ? { ...d, name: renameValue.trim() || d.name } : d));
    },
    [draftsLib, renameValue],
  );

  const duplicateSaved = useCallback(
    async (source: EmailDraft) => {
      const { error } = await draftsLib.duplicateDraft(source);
      setStorageNotice(error ? storeErrorMessage(error) : null);
    },
    [draftsLib],
  );

  const deleteSaved = useCallback(
    async (id: string) => {
      if (deleteArmId !== id) {
        setDeleteArmId(id);
        return;
      }
      setDeleteArmId(null);
      const err = await draftsLib.deleteDraft(id);
      setStorageNotice(err ? storeErrorMessage(err) : null);
    },
    [draftsLib, deleteArmId],
  );

  // --- priced-action driver -------------------------------------------------

  const prepare = useCallback(
    (action: Omit<PendingConfirm, 'cost'>) => {
      if (anon) {
        requestSignIn();
        setNotice("You're browsing as a guest — sign in to generate.");
        return;
      }
      if (!grantedRef.current) {
        parkedRef.current = () => prepare(action);
        setPhase('needs-consent');
        setNotice('This needs your permission to spend Buzz. Approve it and we’ll pick up right where you left off.');
        requestConsent({ scopes: ['ai:write:budgeted'] });
        return;
      }
      setPhase('estimating');
      setNotice(null);
      void (async () => {
        try {
          const est = await estimate(action.body);
          const cost = est.cost?.total;
          if (est.status === 'failed' || typeof cost !== 'number') {
            setPhase('idle');
            setNotice('Couldn’t price that just now — nothing was spent. Try again in a moment.');
            return;
          }
          setPending({ ...action, cost });
          setPhase('confirming');
        } catch {
          setPhase('idle');
          setNotice('Couldn’t price that just now — nothing was spent. Try again in a moment.');
        }
      })();
    },
    [anon, estimate, requestConsent, requestSignIn],
  );

  // Auto-resume a parked action once the consent grant lands on the token.
  useEffect(() => {
    if (granted && parkedRef.current) {
      const run = parkedRef.current;
      parkedRef.current = null;
      setPhase('idle');
      run();
    }
  }, [granted]);

  // A consent refusal is final here — stop promising a dialog.
  useEffect(() => {
    if (refusal && phase === 'needs-consent') {
      parkedRef.current = null;
      setPhase('idle');
      setNotice('Buzz spending can’t be granted in this context, so generation is unavailable here.');
    }
  }, [refusal, phase]);

  /** Submit + poll to terminal, with the shared failure semantics. */
  const executeRun = useCallback(
    async (
      body: WorkflowBody,
      key: string,
      onSuccess: (snap: BlockWorkflowSnapshot) => void | Promise<void>,
    ) => {
      setPhase('working');
      try {
        const { submit: s, poll: p } = pollDepsRef.current;
        const snap = await runToTerminal(s, p, body, key);
        setPhase('idle');
        if (snap.status !== 'succeeded') {
          const msg = (snap.error ?? '').toLowerCase();
          setNotice(
            msg.includes('insufficient') || msg.includes('not enough')
              ? 'Not enough Buzz for that generation — top up and try again.'
              : 'That generation didn’t complete. If Buzz was spent it’ll show in your transactions; retrying uses the same request, so you won’t be charged twice for it.',
          );
          return;
        }
        await onSuccess(snap);
      } catch {
        setPhase('idle');
        setNotice('Couldn’t reach the generation service after several retries. Your generation may still be running — give it a moment before retrying.');
      }
    },
    [],
  );

  const confirmPending = useCallback(() => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    void executeRun(action.body, action.key, action.onSuccess);
  }, [pending, executeRun]);

  /**
   * Chat turns send immediately (v0.1.4 feedback): no price-confirm card —
   * Enter or Send just sends. Sign-in and consent gates still apply; the
   * bundle and the banner keep their confirms (bigger, priced-up-front work).
   */
  const runChatTurn = useCallback(
    (
      body: WorkflowBody,
      key: string,
      onSuccess: (snap: BlockWorkflowSnapshot) => void | Promise<void>,
    ) => {
      if (anon) {
        requestSignIn();
        setNotice("You're browsing as a guest — sign in to generate.");
        return;
      }
      if (!grantedRef.current) {
        parkedRef.current = () => runChatTurn(body, key, onSuccess);
        setPhase('needs-consent');
        setNotice('This needs your permission to spend Buzz. Approve it and we’ll pick up right where you left off.');
        requestConsent({ scopes: ['ai:write:budgeted'] });
        return;
      }
      void executeRun(body, key, onSuccess);
    },
    [anon, executeRun, requestConsent, requestSignIn],
  );

  /**
   * The one disclosed repair retry: re-ask the model to fix its own
   * malformed reply (salvage already failed locally). Null on transport
   * failure; the caller falls back to the two-tries failure notice.
   */
  const attemptRepair = useCallback(
    async (
      kind: 'interview' | 'bundle' | 'refine',
      rawText: string,
      problem: string,
    ): Promise<{
      snap: BlockWorkflowSnapshot;
      outcome: ReturnType<typeof textOutcomeFromSnapshot>;
    } | null> => {
      try {
        const { submit: s, poll: p } = pollDepsRef.current;
        const snap = await runToTerminal(
          s,
          p,
          buildRepairBody(kind, rawText, problem, chatModel),
          idempotencyKeyFor(`repair:${kind}:${rawText.length}:${rawText.slice(0, 120)}`),
        );
        if (snap.status !== 'succeeded') return { snap, outcome: { type: 'none' } };
        return { snap, outcome: textOutcomeFromSnapshot(snap) };
      } catch {
        return null;
      }
    },
    [chatModel],
  );

  // --- the four priced actions ----------------------------------------------

  // --- outcome processors (salvage → repair → apply) -----------------------

  const applyInterviewTurn = useCallback(
    (read: NonNullable<ReturnType<typeof salvageInterviewTurn>>) => {
      // Field-level recovery is seamless — only prose salvage (the model
      // ignored JSON entirely) earns a note, so normal replies stay quiet.
      if (read.via === 'prose') showFlash('Recovered that reply — it arrived in a messy shape.');
      else setNotice(null);
      const turn = read.result;
      setDraft((d) => ({
        ...d,
        brief: mergeBriefs(d.brief, turn.brief),
        transcript: [...d.transcript, { role: 'assistant' as const, content: turn.reply }],
      }));
    },
    [showFlash],
  );

  const processInterviewText = useCallback(
    async (text: string, snaps: BlockWorkflowSnapshot[]) => {
      stashRawReply(text);
      const read = salvageInterviewTurn(text);
      if (read) {
        applyInterviewTurn(read);
        return;
      }
      // Unreadable: offer ONE repair as a single tap (chat sends no longer
      // pass a confirm card, so the extra charge needs its own yes).
      setNotice('The assistant replied in a shape I couldn’t read.');
      setRepairOffer({
        run: async () => {
          setRepairOffer(null);
          const r = await attemptRepair(
            'interview',
            text,
            interviewTurnProblem(text) ?? 'unreadable reply shape',
          );
          if (r && r.outcome.type === 'text') {
            const again = salvageInterviewTurn(r.outcome.text);
            if (again) {
              applyInterviewTurn(again);
              return;
            }
            setNotice(
              `The assistant replied in a shape I couldn’t read — try sending again.${combinedChargeSuffix([...snaps, r.snap])}`,
            );
            return;
          }
          setNotice(
            `The assistant replied in a shape I couldn’t read — try sending again.${r ? combinedChargeSuffix([...snaps, r.snap]) : chargeSuffix(snaps[0]!)}`,
          );
        },
      });
    },
    [applyInterviewTurn, attemptRepair],
  );

  const processRefineText = useCallback(
    async (text: string, snaps: BlockWorkflowSnapshot[], variant: EmailVariant, instruction: string) => {
      stashRawReply(text);
      const apply = (variant2: EmailVariant, recovered: boolean) => {
        if (recovered) showFlash('Recovered that revision — it arrived in a messy shape.');
        else setNotice(null);
        const cur = draftRef.current;
        const next: EmailDraft = {
          ...cur,
          variants: replaceVariant(cur.variants, variant2),
          transcript: [
            ...cur.transcript,
            { role: 'assistant' as const, content: `Revised ${variant.name}: “${instruction}”` },
          ],
        };
        setDraft(next);
        void saveOnly(next);
      };
      const read = salvageRefinedVariant(text, variant);
      if (read) {
        apply(read.variant, read.recovered);
        return;
      }
      setNotice('The revision didn’t come back in a usable shape — your email is unchanged.');
      setRepairOffer({
        run: async () => {
          setRepairOffer(null);
          const r = await attemptRepair(
            'refine',
            text,
            refinedVariantProblem(text, variant) ?? 'unreadable reply shape',
          );
          if (r && r.outcome.type === 'text') {
            const again = salvageRefinedVariant(r.outcome.text, variant);
            if (again) {
              apply(again.variant, false);
              return;
            }
            setNotice(
              `The revision didn’t come back in a usable shape — your email is unchanged.${combinedChargeSuffix([...snaps, r.snap])}`,
            );
            return;
          }
          setNotice(
            `The revision didn’t come back in a usable shape — your email is unchanged.${r ? combinedChargeSuffix([...snaps, r.snap]) : chargeSuffix(snaps[0]!)}`,
          );
        },
      });
    },
    [attemptRepair, saveOnly, showFlash],
  );

  const processBundleText = useCallback(
    async (text: string, snaps: BlockWorkflowSnapshot[]) => {
      stashRawReply(text);
      let read = salvageEmailBundle(text);
      if (!read) {
        // The bundle keeps the v0.1.3 auto-repair: its price-confirm card
        // already disclosed the retry before the user confirmed.
        const r = await attemptRepair(
          'bundle',
          text,
          emailBundleProblem(text) ?? 'unreadable reply shape',
        );
        if (r) {
          snaps = [...snaps, r.snap];
          if (r.outcome.type === 'text') read = salvageEmailBundle(r.outcome.text);
        }
      }
      if (!read) {
        setNotice(
          `The copy didn’t come back in a usable shape — your brief is unchanged.${combinedChargeSuffix(snaps)}`,
        );
        return;
      }
      if (read.recovered) showFlash('Recovered that package — it arrived in a messy shape.');
      const bundle = read.bundle;
      setSubjectIdx(0);
      const cur = draftRef.current;
      const next: EmailDraft = {
        ...cur,
        name: cur.brief.purpose.trim().slice(0, 48) || cur.name,
        subjects: bundle.subjects,
        preheader: bundle.preheader,
        variants: bundle.variants,
        selectedVariantId: bundle.variants[0]?.id ?? '',
        bannerUrl: '',
        bannerWorkflowId: '',
        // The draft is born in the chat (v0.1.4): a widget the user can
        // pick variants from without leaving the conversation.
        transcript: [
          ...cur.transcript,
          {
            role: 'assistant' as const,
            content: 'Your email draft is ready — pick a variant, or keep chatting to revise it.',
            widget: {
              type: 'draft' as const,
              subjects: bundle.subjects,
              variants: bundle.variants.map((v) => ({ id: v.id, name: v.name, headline: v.headline })),
            },
          },
        ],
      };
      setDraft(next);
      void saveOnly(next);
      showFlash('Your email package is ready — pick a variant, generate its banner, tweak anything.');
    },
    [attemptRepair, saveOnly, showFlash],
  );

  // --- the four priced actions ----------------------------------------------

  const sendChat = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setRepairOffer(null);

    if (hasBundle && selectedVariant) {
      // Refinement mode: one chat instruction revises the selected variant.
      const transcript = [...draft.transcript, { role: 'user' as const, content: text }];
      setDraft((d) => ({ ...d, transcript }));
      const variant = selectedVariant;
      runChatTurn(
        buildRefineBody(variant, text, draft.brief, chatModel),
        idempotencyKeyFor(`${draft.id}:refine:${variant.id}:${transcript.length}`),
        async (snap) => {
          const outcome = textOutcomeFromSnapshot(snap);
          if (outcome.type === 'withheld') {
            setNotice(`The revision was held back: ${outcome.reason}.${chargeSuffix(snap)}`);
            return;
          }
          if (outcome.type !== 'text') {
            setNotice(`The revision didn’t come back — your email is unchanged.${chargeSuffix(snap)}`);
            return;
          }
          await processRefineText(outcome.text, [snap], variant, text);
        },
      );
      return;
    }

    // Interview mode — sends immediately, no confirm (v0.1.4).
    const transcript = [...draft.transcript, { role: 'user' as const, content: text }];
    setDraft((d) => ({ ...d, transcript }));
    runChatTurn(
      buildInterviewBody(transcript, chatModel),
      idempotencyKeyFor(`${draft.id}:interview:${transcript.length}`),
      async (snap) => {
        const outcome = textOutcomeFromSnapshot(snap);
        if (outcome.type === 'withheld') {
          setNotice(`That reply was held back: ${outcome.reason}.${chargeSuffix(snap)}`);
          return;
        }
        if (outcome.type !== 'text') {
          setNotice(`The assistant didn’t reply — your message is saved above, try sending again.${chargeSuffix(snap)}`);
          return;
        }
        await processInterviewText(outcome.text, [snap]);
      },
    );
  }, [
    input,
    busy,
    hasBundle,
    selectedVariant,
    draft,
    runChatTurn,
    chatModel,
    processInterviewText,
    processRefineText,
  ]);

  const generateBundle = useCallback(() => {
    prepare({
      kind: 'bundle',
      label: 'Generate email package (3 subjects + 3 variants)',
      costIsCap: false,
      repairNote: true,
      body: buildBundleBody(draft.brief, chatModel),
      key: idempotencyKeyFor(`${draft.id}:bundle:${draft.transcript.length}`),
      onSuccess: async (snap) => {
        const outcome = textOutcomeFromSnapshot(snap);
        if (outcome.type === 'withheld') {
          setNotice(`The copy was held back: ${outcome.reason}.${chargeSuffix(snap)}`);
          return;
        }
        if (outcome.type !== 'text') {
          setNotice(`The copy didn’t come back — your brief is unchanged.${chargeSuffix(snap)}`);
          return;
        }
        await processBundleText(outcome.text, [snap]);
      },
    });
  }, [draft, prepare, chatModel, processBundleText]);

  const generateBanner = useCallback(() => {
    if (!selectedVariant) return;
    const variant = selectedVariant;
    prepare({
      kind: 'banner',
      label: `Generate banner for “${variant.name}” (Nano Banana)`,
      costIsCap: true,
      body: buildBannerBody(variant.bannerPrompt),
      key: idempotencyKeyFor(`${draft.id}:banner:${variant.id}:${variant.bannerPrompt}`),
      onSuccess: (snap) => {
        const url = bannerUrlFromSnapshot(snap);
        if (!url) {
          setNotice('The banner didn’t come back with an image — try again.');
          return;
        }
        const next: EmailDraft = {
          ...draftRef.current,
          bannerUrl: url,
          bannerWorkflowId: snap.workflowId,
        };
        setDraft(next);
        void saveOnly(next);
      },
    });
  }, [draft.id, selectedVariant, prepare, saveOnly]);

  // --- manual tweaks ----------------------------------------------------------

  const patchVariant = useCallback(
    (patch: Partial<EmailVariant>) => {
      if (!selectedVariant) return;
      setDraft((d) => ({
        ...d,
        variants: d.variants.map((v) => (v.id === selectedVariant.id ? { ...v, ...patch } : v)),
      }));
    },
    [selectedVariant],
  );

  const patchSubject = useCallback(
    (value: string) => {
      setDraft((d) => {
        const subjects = [...d.subjects];
        subjects[subjectIdx] = value;
        return { ...d, subjects };
      });
    },
    [subjectIdx],
  );

  // --- export -----------------------------------------------------------------

  const copyHtml = useCallback(async () => {
    if (!selectedVariant) return;
    const html = buildEmailHtml(draft, selectedVariant, draft.subjects[subjectIdx] ?? draft.name);
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      showFlash('HTML copied — paste it into your email tool.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice('Copy was blocked here — try Download HTML instead.');
    }
  }, [draft, selectedVariant, subjectIdx, showFlash]);

  const downloadHtml = useCallback(() => {
    if (!selectedVariant) return;
    const html = buildEmailHtml(draft, selectedVariant, draft.subjects[subjectIdx] ?? draft.name);
    try {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = emailExportFilename(draft.name);
      a.click();
      showFlash(`Downloaded ${emailExportFilename(draft.name)}.`);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      setNotice('Download was blocked here — Copy HTML works everywhere.');
    }
  }, [draft, selectedVariant, subjectIdx, showFlash]);

  // --- render -------------------------------------------------------------------

  if (!ready) {
    return (
      <div ref={rootRef} data-theme={theme} style={shellStyle}>
        <p>Loading…</p>
      </div>
    );
  }

  const brief = draft.brief;
  const readyToGenerate = briefIsReady(brief);

  return (
    <div
      ref={rootRef}
      data-theme={theme}
      data-palette={palette?.id}
      data-testid="eb-app"
      style={{
        ...shellStyle,
        ...((theme === 'light' && palette.id === DEFAULT_PALETTE.id
          ? CORAL_POST_LIGHT
          : palette.vars) as CSSProperties),
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Email Builder</h1>
            <span style={hintStyle} data-testid="eb-current-draft">
              Editing: {draft.name}
            </span>
          </div>
          <Group gap="sm" align="center" wrap>
            {anon && (
              <Button size="sm" variant="light" onClick={() => requestSignIn()} data-testid="eb-signin">
                Sign in to generate
              </Button>
            )}
            <Button size="sm" variant="light" onClick={startNew} data-testid="eb-new">
              New email
            </Button>
            <Button
              size="sm"
              variant="light"
              onClick={() => void persist(draft, { announce: true })}
              data-testid="eb-save-draft"
            >
              Save draft
            </Button>
          </Group>
        </Group>

        {notice && (
          <Alert color="warning" data-testid="eb-notice">
            {notice}
          </Alert>
        )}
        {flash && (
          <Alert color="success" data-testid="eb-flash">
            {flash}
          </Alert>
        )}
        {storageNotice && (
          <Alert color="warning" data-testid="eb-storage-notice">
            {storageNotice}
          </Alert>
        )}
        {repairOffer && (
          <Card withBorder data-testid="eb-repair-offer">
            <Group justify="space-between" align="center" wrap>
              <span style={hintStyle}>
                I can ask the model to fix its own reply — that’s one more chat charge.
              </span>
              <Group gap="sm">
                <Button size="sm" onClick={() => void repairOffer.run()} data-testid="eb-repair-run">
                  Fix that reply
                </Button>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => setRepairOffer(null)}
                  data-testid="eb-repair-dismiss"
                >
                  Dismiss
                </Button>
              </Group>
            </Group>
          </Card>
        )}

        {pending && phase === 'confirming' && (
          <div
            ref={confirmRef}
            style={{ position: 'sticky', top: 8, zIndex: 6 }}
            data-testid="eb-confirm-wrap"
          >
          <Card withBorder data-testid="eb-confirm">
            <Group justify="space-between" align="center" wrap>
              <span>
                {pending.label} —{' '}
                <strong>
                  {pending.costIsCap
                    ? `up to ${formatBuzz(pending.cost)}`
                    : formatBuzz(pending.cost)}
                </strong>
              </span>
              <Group gap="sm">
                <Button size="sm" onClick={confirmPending} data-testid="eb-confirm-run">
                  Confirm &amp; generate
                </Button>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => {
                    setPending(null);
                    setPhase('idle');
                  }}
                  data-testid="eb-confirm-cancel"
                >
                  Cancel
                </Button>
              </Group>
              {pending.repairNote && (
                <div style={{ ...hintStyle, marginTop: 6 }}>
                  If the AI’s reply comes back malformed, one automatic fix-up retry runs at the
                  same price — only when needed.
                </div>
              )}
            </Group>
          </Card>
          </div>
        )}

        <div style={narrow ? columnStyle : rowStyle}>
          {/* LEFT — chat, brief, drafts */}
          <div style={colStyle}>
            <Stack gap="md">
              <Card withBorder>
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <strong>{hasBundle ? 'Revise by chat' : 'Interview'}</strong>
                    {busy && <Badge variant="light">working…</Badge>}
                  </Group>
                  <div ref={transcriptRef} data-testid="eb-transcript" style={transcriptStyle}>
                    {draft.transcript.map((t, i) =>
                      t.widget?.type === 'draft' ? (
                        <Card key={i} withBorder padding="sm" data-testid="eb-draft-widget">
                          <Stack gap="xs">
                            <strong>Your email draft</strong>
                            <span style={hintStyle}>{t.content}</span>
                            <Group gap="xs">
                              {t.widget.subjects.map((sub) => (
                                <Badge key={sub} variant="light">
                                  {sub}
                                </Badge>
                              ))}
                            </Group>
                            <Group gap="xs">
                              {t.widget.variants.map((v) => (
                                <Button
                                  key={v.id}
                                  size="sm"
                                  variant={v.id === draft.selectedVariantId ? 'filled' : 'light'}
                                  onClick={() =>
                                    setDraft((d) => ({ ...d, selectedVariantId: v.id }))
                                  }
                                  data-testid={`eb-widget-variant-${v.id}`}
                                >
                                  {v.name}
                                </Button>
                              ))}
                            </Group>
                            <span style={hintStyle}>
                              Preview, banner, and manual tweaks live in the editor panels.
                            </span>
                          </Stack>
                        </Card>
                      ) : (
                        <div
                          key={i}
                          style={t.role === 'user' ? userBubbleStyle : assistantBubbleStyle}
                        >
                          {t.content}
                        </div>
                      ),
                    )}
                  </div>
                  <Group gap="sm" align="center">
                    <label style={hintStyle} htmlFor="eb-model-select">
                      Model
                    </label>
                    <select
                      id="eb-model-select"
                      data-testid="eb-model-select"
                      value={chatModel}
                      onChange={(e) => pickModel(e.currentTarget.value as ChatModelId)}
                      style={selectStyle}
                    >
                      {CHAT_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <span style={hintStyle}>Enter sends · Shift+Enter for a new line</span>
                  </Group>
                  <Textarea
                    aria-label="Chat message"
                    data-testid="eb-chat-input"
                    placeholder={
                      hasBundle
                        ? 'e.g. make it shorter, friendlier, add a deadline…'
                        : 'Describe the email you want to send…'
                    }
                    value={input}
                    onChange={(e) => setInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                    minRows={2}
                  />
                  <Button onClick={sendChat} disabled={!input.trim() || busy} data-testid="eb-send">
                    {hasBundle ? 'Send revision' : 'Send'}
                  </Button>
                </Stack>
              </Card>

              <Card withBorder data-testid="eb-brief">
                <Stack gap="xs">
                  <Group justify="space-between" align="center">
                    <strong>Brief</strong>
                    {readyToGenerate ? (
                      <Badge color="green" variant="light">
                        ready
                      </Badge>
                    ) : (
                      <Badge variant="light">in progress</Badge>
                    )}
                  </Group>
                  <BriefLine label="Purpose" value={brief.purpose} />
                  <BriefLine label="Audience" value={brief.audience} />
                  <BriefLine label="Tone" value={brief.tone} />
                  <BriefLine label="CTA" value={[brief.ctaText, brief.ctaUrl].filter(Boolean).join(' · ')} />
                  <BriefLine label="Key points" value={brief.keyPoints.join('; ')} />
                  <BriefLine label="Sender" value={brief.senderName} />
                  <BriefLine label="Banner" value={brief.bannerVibe} />
                  <Button
                    onClick={generateBundle}
                    disabled={!readyToGenerate || busy}
                    data-testid="eb-generate-bundle"
                  >
                    Generate email package
                  </Button>
                  {!readyToGenerate && (
                    <span style={hintStyle}>
                      Needs a purpose, an audience, and at least one key point — keep chatting.
                    </span>
                  )}
                </Stack>
              </Card>

              <Card withBorder data-testid="eb-drafts">
                <Stack gap="xs">
                  <strong>Your drafts &amp; templates</strong>
                  {draftsLib.drafts.length === 0 && (
                    <span style={hintStyle}>Nothing saved yet — generated emails save here.</span>
                  )}
                  {draftsLib.drafts.map((d) => (
                    <div key={d.id}>
                      {renamingId === d.id ? (
                        <Group gap="xs" align="center" wrap>
                          <TextInput
                            aria-label="Draft name"
                            data-testid="eb-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.currentTarget.value)}
                            style={{ flex: 1, minWidth: 140 }}
                          />
                          <Button size="sm" onClick={() => void commitRename(d.id)} data-testid="eb-rename-save">
                            Save
                          </Button>
                          <Button size="sm" variant="light" onClick={() => setRenamingId(null)}>
                            Cancel
                          </Button>
                        </Group>
                      ) : (
                        <Group justify="space-between" align="center" wrap>
                          <span style={{ minWidth: 0 }}>
                            {d.name}
                            <span style={hintStyle}>
                              {' '}
                              · {d.variants.length} {d.variants.length === 1 ? 'variant' : 'variants'}
                            </span>
                          </span>
                          <Group gap="xs">
                            <Button size="sm" variant="light" onClick={() => loadDraft(d)}>
                              Open
                            </Button>
                            <Button
                              size="sm"
                              variant="light"
                              data-testid={`eb-rename-${d.id}`}
                              onClick={() => {
                                setRenameValue(d.name);
                                setRenamingId(d.id);
                              }}
                            >
                              Rename
                            </Button>
                            <Button
                              size="sm"
                              variant="light"
                              data-testid={`eb-duplicate-${d.id}`}
                              onClick={() => void duplicateSaved(d)}
                            >
                              Duplicate
                            </Button>
                            <Button
                              size="sm"
                              variant="light"
                              color="red"
                              data-testid={`eb-delete-${d.id}`}
                              onClick={() => void deleteSaved(d.id)}
                            >
                              {deleteArmId === d.id ? 'Confirm delete' : 'Delete'}
                            </Button>
                          </Group>
                        </Group>
                      )}
                    </div>
                  ))}
                </Stack>
              </Card>
            </Stack>
          </div>

          {/* RIGHT — variants, preview, tweaks */}
          <div style={colStyle}>
            <Stack gap="md">
              {hasBundle && selectedVariant ? (
                <>
                  <Card withBorder>
                    <Stack gap="sm">
                      <strong>Subject options</strong>
                      <Group gap="xs" wrap>
                        {draft.subjects.map((s, i) => (
                          <Button
                            key={i}
                            size="sm"
                            variant={i === subjectIdx ? 'filled' : 'light'}
                            onClick={() => setSubjectIdx(i)}
                            data-testid={`eb-subject-${i}`}
                          >
                            {s || `Subject ${i + 1}`}
                          </Button>
                        ))}
                      </Group>
                      {draft.preheader && <span style={hintStyle}>Preheader: {draft.preheader}</span>}
                      <strong>Template variants</strong>
                      <Group gap="xs" wrap>
                        {draft.variants.map((v) => (
                          <Button
                            key={v.id}
                            size="sm"
                            variant={v.id === selectedVariant.id ? 'filled' : 'light'}
                            onClick={() => setDraft((d) => ({ ...d, selectedVariantId: v.id }))}
                            data-testid={`eb-variant-${v.id}`}
                          >
                            {v.name}
                          </Button>
                        ))}
                      </Group>
                      <Group gap="sm" align="center" wrap>
                        <Button
                          size="sm"
                          onClick={generateBanner}
                          disabled={busy || !selectedVariant.bannerPrompt}
                          data-testid="eb-banner-generate"
                        >
                          {draft.bannerUrl ? 'Regenerate banner' : 'Generate banner'}
                        </Button>
                        <span style={hintStyle}>Nano Banana · up to {BANNER_MAX_BUZZ} Buzz</span>
                      </Group>
                    </Stack>
                  </Card>

                  <Card withBorder data-testid="eb-preview">
                    <Stack gap="sm">
                      <Group justify="space-between" align="center" wrap>
                        <strong>Live preview</strong>
                        <SegmentedControl
                          size="sm"
                          value={previewWidth}
                          onChange={(v) => setPreviewWidth(v as 'desktop' | 'mobile')}
                          data={[
                            { label: 'Desktop', value: 'desktop' },
                            { label: 'Mobile', value: 'mobile' },
                          ]}
                        />
                      </Group>
                      <div style={previewFrameStyle}>
                        <div
                          style={{
                            ...emailCanvasStyle,
                            transition: 'max-width .25s ease',
                            maxWidth: previewWidth === 'desktop' ? 600 : 360,
                          }}
                        >
                          {draft.bannerUrl && !bannerBroken ? (
                            <img
                              src={draft.bannerUrl}
                              alt="Email banner"
                              data-testid="eb-banner-img"
                              style={bannerImgStyle}
                              onError={() => setBannerBroken(true)}
                            />
                          ) : (
                            <div style={bannerPlaceholderStyle} data-testid="eb-banner-placeholder">
                              {bannerBroken ? (
                                <span>
                                  Banner image unavailable — the link may have expired.{' '}
                                  <button
                                    type="button"
                                    onClick={generateBanner}
                                    style={bannerRetryStyle}
                                    data-testid="eb-banner-regenerate"
                                  >
                                    Regenerate banner
                                  </button>
                                </span>
                              ) : (
                                selectedVariant.bannerPrompt || 'Your banner will appear here'
                              )}
                            </div>
                          )}
                          <div style={{ padding: '20px 24px' }}>
                            <div style={headlineStyle}>{selectedVariant.headline}</div>
                            {selectedVariant.body.map((p, i) => (
                              <p key={i} style={paraStyle}>
                                {p}
                              </p>
                            ))}
                            <span style={ctaStyle}>
                              {selectedVariant.ctaText || brief.ctaText || 'Learn more'}
                            </span>
                            {brief.senderName && (
                              <p style={signoffStyle}>— {brief.senderName}</p>
                            )}
                          </div>
                        </div>
                      </div>
                      <Group gap="sm">
                        <Button size="sm" variant="light" onClick={() => void copyHtml()} data-testid="eb-copy-html">
                          {copied ? 'Copied ✓' : 'Copy HTML'}
                        </Button>
                        <Button size="sm" variant="light" onClick={downloadHtml} data-testid="eb-download-html">
                          Download HTML
                        </Button>
                      </Group>
                    </Stack>
                  </Card>

                  <Card withBorder data-testid="eb-edit">
                    <Stack gap="sm">
                      <strong>Manual tweaks</strong>
                      <TextInput
                        label="Subject"
                        aria-label="Subject"
                        value={draft.subjects[subjectIdx] ?? ''}
                        onChange={(e) => patchSubject(e.currentTarget.value)}
                      />
                      <TextInput
                        label="Headline"
                        aria-label="Headline"
                        data-testid="eb-headline"
                        value={selectedVariant.headline}
                        onChange={(e) => patchVariant({ headline: e.currentTarget.value })}
                      />
                      <Textarea
                        label="Body (blank line between paragraphs)"
                        aria-label="Body"
                        data-testid="eb-body"
                        minRows={5}
                        value={selectedVariant.body.join('\n\n')}
                        onChange={(e) =>
                          patchVariant({
                            body: e.currentTarget.value
                              .split(/\n\s*\n/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                      <TextInput
                        label="Button text"
                        aria-label="Button text"
                        data-testid="eb-cta"
                        value={selectedVariant.ctaText}
                        onChange={(e) => patchVariant({ ctaText: e.currentTarget.value })}
                      />
                      <Textarea
                        label="Banner prompt"
                        aria-label="Banner prompt"
                        minRows={2}
                        value={selectedVariant.bannerPrompt}
                        onChange={(e) => patchVariant({ bannerPrompt: e.currentTarget.value })}
                      />
                    </Stack>
                  </Card>
                </>
              ) : (
                <Card withBorder data-testid="eb-preview-empty">
                  <Stack gap="sm">
                    <strong>Live preview</strong>
                    <span style={hintStyle}>
                      {draft.brief.purpose || draft.brief.keyPoints.length > 0
                        ? 'This draft has a brief but no email package yet — hit “Generate email package” to create subject options and variants.'
                        : 'Chat through the brief on the left, then generate your email package — three subject options and three template variants land here with a live preview you can tweak by chat or by hand.'}
                    </span>
                  </Stack>
                </Card>
              )}
            </Stack>
          </div>
        </div>
      </Stack>
    </div>
  );
}

function BriefLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 13 }}>
      <span style={{ opacity: 0.65 }}>{label}: </span>
      {value ? value : <span style={{ opacity: 0.45 }}>—</span>}
    </div>
  );
}

// --- styles -------------------------------------------------------------------

const shellStyle: CSSProperties = { maxWidth: 1180, margin: '0 auto', padding: 16 };
const selectStyle: CSSProperties = {
  background: 'var(--civitai-color-surface)',
  color: 'var(--civitai-color-text)',
  border: '1px solid var(--civitai-color-border)',
  borderRadius: 8,
  padding: '4px 8px',
};
const rowStyle: CSSProperties = { display: 'flex', gap: 16, alignItems: 'flex-start' };
const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const colStyle: CSSProperties = { flex: 1, minWidth: 0 };
const transcriptStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 320,
  overflowY: 'auto',
};
const userBubbleStyle: CSSProperties = {
  alignSelf: 'flex-end',
  maxWidth: '85%',
  padding: '8px 12px',
  borderRadius: 12,
  background: 'var(--civitai-color-primary, #1971c2)',
  color: '#fff',
  fontSize: 14,
  whiteSpace: 'pre-wrap',
};
const assistantBubbleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '85%',
  padding: '8px 12px',
  borderRadius: 12,
  background: 'rgba(128,128,128,0.18)',
  fontSize: 14,
  whiteSpace: 'pre-wrap',
};
const hintStyle: CSSProperties = { fontSize: 12, opacity: 0.65 };
const previewFrameStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  background: 'rgba(128,128,128,0.14)',
  borderRadius: 8,
  padding: 12,
};
const emailCanvasStyle: CSSProperties = {
  width: '100%',
  background: '#ffffff',
  color: '#17181a',
  borderRadius: 8,
  overflow: 'hidden',
  transition: 'max-width 160ms ease',
};
const bannerImgStyle: CSSProperties = { display: 'block', width: '100%', height: 'auto' };
const bannerRetryStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#7cc4ff',
  textDecoration: 'underline',
  cursor: 'pointer',
  font: 'inherit',
};

const bannerPlaceholderStyle: CSSProperties = {
  padding: '28px 24px',
  background: 'linear-gradient(135deg, #1971c2, #e8590c)',
  color: '#fff',
  fontStyle: 'italic',
  fontSize: 13,
};
const headlineStyle: CSSProperties = { fontSize: 24, fontWeight: 700, lineHeight: 1.25, marginBottom: 12 };
const paraStyle: CSSProperties = { fontSize: 15, lineHeight: 1.6, margin: '0 0 12px' };
const ctaStyle: CSSProperties = {
  display: 'inline-block',
  background: '#1971c2',
  color: '#fff',
  fontWeight: 600,
  fontSize: 15,
  padding: '10px 20px',
  borderRadius: 6,
  marginTop: 4,
};
const signoffStyle: CSSProperties = { fontSize: 13, color: '#5c5f66', marginTop: 16 };
