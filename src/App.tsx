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
import { copyTextBounded } from './clipboard.js';
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
  /** Package confirm also covers the banner leg: flat observed price + cap. */
  bannerLeg?: { flatCost: number; cap: number };
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

/** A draft worth persisting: the user has actually put something in it. */
function isDraftTouched(d: EmailDraft): boolean {
  return d.transcript.length > 1 || d.variants.length > 0 || d.brief.purpose.trim().length > 0;
}

/** Content fingerprint for auto-save. `updatedAt` is persistence metadata,
 * not user content, so stamping a save must not make the draft look changed. */
function draftSaveSignature(d: EmailDraft): string {
  return JSON.stringify({ ...d, updatedAt: '' });
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

/** Dev-harness-only: a finished package with NO banner yet (?seed=nobanner),
 * so screenshots can show the banner slot + its Generate button. */
const isSeedNoBanner =
  import.meta.env.VITE_DEV_HARNESS === 'true' &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('seed') === 'nobanner';

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

  const [draft, setDraft] = useState<EmailDraft>(() =>
    isSeedDemo ? demoDraft() : isSeedNoBanner ? { ...demoDraft(), bannerUrl: '' } : freshDraft(),
  );
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Kit styles settle a beat after mount; position now and on the next
    // frame. When the transcript fits (or nearly), start at the top so the
    // first bubble is not half-clipped; pin to the bottom only on a real
    // overflow so the newest turn is what the user sees.
    const el = transcriptRef.current;
    if (!el) return;
    const toSpot = () => {
      el.scrollTop = el.scrollHeight - el.clientHeight > 48 ? el.scrollHeight : 0;
    };
    toSpot();
    const raf = requestAnimationFrame(toSpot);
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
  const [repairOffer, setRepairOffer] = useState<{
    run: () => Promise<void>;
    text?: string;
    action?: string;
  } | null>(null);
  // v0.1.5 declutter: what shows is driven by state, not habit.
  const [modelOpen, setModelOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState<boolean | null>(null);
  const [draftsOpen, setDraftsOpen] = useState<boolean | null>(null);
  const [draftsDrawerOpen, setDraftsDrawerOpen] = useState(false);
  const [openDraftMenu, setOpenDraftMenu] = useState<string | null>(null);
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
  // Chat-card sessions (v0.1.11): every saved campaign plus the one on
  // screen, so jumping between in-progress campaigns is one tap.
  const sessions = useMemo(
    () =>
      draftsLib.drafts.some((d) => d.id === draft.id)
        ? draftsLib.drafts
        : [draft, ...draftsLib.drafts],
    [draftsLib.drafts, draft],
  );

  const busy = phase === 'estimating' || phase === 'working';

  // --- draft mutation + persistence ---------------------------------------

  // Latest draft for async completions (a priced action resolves after the
  // render that started it). Money callbacks compute their next draft from
  // here and set it directly — never a setState inside a state updater.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedSignatureRef = useRef<string | null>(null);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const markSaved = useCallback((d: EmailDraft) => {
    const signature = draftSaveSignature(d);
    savedSignatureRef.current = signature;
    setSavedSignature(signature);
  }, []);
  const clearSaved = useCallback(() => {
    savedSignatureRef.current = null;
    setSavedSignature(null);
  }, []);
  const saveOnly = useCallback(
    async (d: EmailDraft) => {
      const err = await draftsLib.saveDraft({ ...d, updatedAt: new Date().toISOString() });
      setStorageNotice(err ? storeErrorMessage(err) : null);
      if (!err) markSaved(d);
      return err;
    },
    [draftsLib.saveDraft, markSaved],
  );

  // Auto-save (v0.1.11): the Save draft button is gone, so a touched draft
  // persists itself a beat after the last change. Quiet while interviewing;
  // says so once an email exists or when it retires an error notice.
  const noticeRef = useRef<string | null>(null);
  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);
  useEffect(() => {
    if (!isDraftTouched(draft)) return;
    // Do not save the same content twice. This matters because a successful
    // save updates the drafts library, which re-renders the app; without this
    // fingerprint guard, auto-save can schedule itself forever and the old
    // transient Saved banner expired/reappeared as a flicker.
    if (draftSaveSignature(draft) === savedSignatureRef.current) return;
    const t = setTimeout(() => {
      void (async () => {
        const cur = draftRef.current;
        if (draftSaveSignature(cur) === savedSignatureRef.current) return;
        const err = await saveOnly(cur);
        // A successful save retires a stale error without flashing a banner.
        if (!err && noticeRef.current !== null) setNotice(null);
      })();
    }, 900);
    return () => clearTimeout(t);
  }, [draft, saveOnly, setNotice]);

  const loadDraft = useCallback(
    (d: EmailDraft) => {
      // A packaged draft always carries its draft card in the transcript
      // (v0.1.4). Drafts saved before the widget existed — or written by
      // anything else — open without one; synthesize it so a reopened
      // finished campaign looks like the one just generated. Local-only:
      // markSaved keeps auto-save from rewriting storage until a real edit.
      const hasWidget = d.transcript.some((t) => t.widget?.type === 'draft');
      const opened: EmailDraft =
        d.variants.length > 0 && !hasWidget
          ? {
              ...d,
              transcript: [
                ...d.transcript,
                {
                  role: 'assistant' as const,
                  content:
                    'Your email draft is ready — pick a variant, or keep chatting to revise it.',
                  widget: {
                    type: 'draft' as const,
                    subjects: d.subjects,
                    variants: d.variants.map((v) => ({
                      id: v.id,
                      name: v.name,
                      headline: v.headline,
                    })),
                  },
                },
              ],
            }
          : d;
      setDraft(opened);
      markSaved(opened);
      setEditOpen(false);
      setSubjectIdx(0);
      setPending(null);
      setPhase('idle');
      setNotice(null);
    },
    [markSaved],
  );


  const startNew = useCallback(() => {
    setDraft(freshDraft());
    clearSaved();
    setEditOpen(false);
    setSubjectIdx(0);
    setPending(null);
    setPhase('idle');
    setNotice(null);
  }, [clearSaved]);

  // Session jumps from the chat card (v0.1.11): never lose the campaign you
  // are leaving — a touched draft saves itself before the switch.
  const openSavedDraft = useCallback(
    async (d: EmailDraft) => {
      setDraftsDrawerOpen(false);
      if (d.id === draftRef.current.id) return;
      if (isDraftTouched(draftRef.current)) await saveOnly(draftRef.current);
      loadDraft(d);
    },
    [saveOnly, loadDraft],
  );

  const startNewSession = useCallback(async () => {
    setDraftsDrawerOpen(false);
    if (isDraftTouched(draftRef.current)) await saveOnly(draftRef.current);
    startNew();
  }, [saveOnly, startNew]);

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
      if (!err && id === draftRef.current.id) startNew();
    },
    [draftsLib, deleteArmId, startNew],
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

  /**
   * Chat-turn outcomes render inside the conversation (v0.1.5): a quiet
   * system note next to the reply it belongs to. The page-top alert is
   * reserved for walls (sign-in, consent, Buzz) that block everything.
   */
  const pushChatNote = useCallback((text: string) => {
    setDraft((d) => ({
      ...d,
      transcript: [
        ...d.transcript,
        { role: 'system' as const, content: text, widget: { type: 'note' as const } },
      ],
    }));
  }, []);

  const applyInterviewTurn = useCallback(
    (read: NonNullable<ReturnType<typeof salvageInterviewTurn>>) => {
      // Field-level recovery is seamless — only prose salvage (the model
      // ignored JSON entirely) earns a note, so normal replies stay quiet.
      if (read.via === 'prose') showFlash('Recovered that reply — it arrived in a messy shape.');
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
      pushChatNote('The assistant replied in a shape I couldn’t read.');
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
            pushChatNote(
              `The assistant replied in a shape I couldn’t read — try sending again.${combinedChargeSuffix([...snaps, r.snap])}`,
            );
            return;
          }
          pushChatNote(
            `The assistant replied in a shape I couldn’t read — try sending again.${r ? combinedChargeSuffix([...snaps, r.snap]) : chargeSuffix(snaps[0]!)}`,
          );
        },
      });
    },
    [applyInterviewTurn, attemptRepair, pushChatNote],
  );

  const processRefineText = useCallback(
    async (text: string, snaps: BlockWorkflowSnapshot[], variant: EmailVariant, instruction: string) => {
      stashRawReply(text);
      const apply = (variant2: EmailVariant, recovered: boolean) => {
        if (recovered) showFlash('Recovered that revision — it arrived in a messy shape.');
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
      pushChatNote('The revision didn’t come back in a usable shape — your email is unchanged.');
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
            pushChatNote(
              `The revision didn’t come back in a usable shape — your email is unchanged.${combinedChargeSuffix([...snaps, r.snap])}`,
            );
            return;
          }
          pushChatNote(
            `The revision didn’t come back in a usable shape — your email is unchanged.${r ? combinedChargeSuffix([...snaps, r.snap]) : chargeSuffix(snaps[0]!)}`,
          );
        },
      });
    },
    [attemptRepair, saveOnly, showFlash, pushChatNote],
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
        return null;
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
      showFlash('Your email package is ready — pick a variant, tweak anything.');
      return next;
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
            pushChatNote(`The revision was held back: ${outcome.reason}.${chargeSuffix(snap)}`);
            return;
          }
          if (outcome.type !== 'text') {
            pushChatNote(`The revision didn’t come back — your email is unchanged.${chargeSuffix(snap)}`);
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
    const handleInterviewSnap = async (snap: BlockWorkflowSnapshot): Promise<void> => {
      const outcome = textOutcomeFromSnapshot(snap);
      if (outcome.type === 'withheld') {
        pushChatNote(`That reply was held back: ${outcome.reason}.${chargeSuffix(snap)}`);
      } else if (outcome.type !== 'text') {
        pushChatNote(`The assistant didn’t reply.${chargeSuffix(snap)}`);
      } else {
        await processInterviewText(outcome.text, [snap]);
        return;
      }
      // Nothing displayable arrived (v0.1.14): offer a one-tap resend of the
      // same turn. It re-spends, so — like the repair offer — it waits for
      // the user's own tap; a fresh key keeps it a separate charge.
      setRepairOffer({
        text: 'The model sent nothing I can show you — send that again? That’s one more chat charge.',
        action: 'Send again',
        run: async () => {
          setRepairOffer(null);
          runChatTurn(
            buildInterviewBody(transcript, chatModel),
            idempotencyKeyFor(`${draft.id}:interview-resend:${transcript.length}:${Date.now()}`),
            handleInterviewSnap,
          );
        },
      });
    };
    runChatTurn(
      buildInterviewBody(transcript, chatModel),
      idempotencyKeyFor(`${draft.id}:interview:${transcript.length}`),
      handleInterviewSnap,
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
    pushChatNote,
  ]);

  const generateBundle = useCallback(() => {
    // One combined confirm (v0.1.9, Zacx's call): the package price includes
    // the banner image, which generates right behind the package — no second
    // card. A draft that already has a banner doesn't re-buy one.
    const withBanner = !draft.bannerUrl;
    prepare({
      kind: 'bundle',
      label: withBanner
        ? 'Generate email package (3 subjects + 3 variants) + banner image'
        : 'Generate email package (3 subjects + 3 variants)',
      costIsCap: false,
      repairNote: true,
      bannerLeg: withBanner ? { flatCost: 104, cap: 150 } : undefined,
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
        const applied = await processBundleText(outcome.text, [snap]);
        if (!applied || !withBanner) return;
        const variant =
          applied.variants.find((v) => v.id === applied.selectedVariantId) ?? applied.variants[0];
        if (!variant || !variant.bannerPrompt) {
          pushChatNote(
            'Your package is ready. This variant has no banner direction, so no banner was generated — the preview slot can make one anytime.',
          );
          return;
        }
        await executeRun(
          buildBannerBody(variant.bannerPrompt),
          idempotencyKeyFor(`${applied.id}:banner:${variant.id}:pkg`),
          (bsnap) => {
            const url = bannerUrlFromSnapshot(bsnap);
            if (!url) {
              pushChatNote(
                'Your package is ready, but the banner came back without an image — Generate banner image in the preview will retry it.',
              );
              return;
            }
            const next: EmailDraft = {
              ...draftRef.current,
              bannerUrl: url,
              bannerWorkflowId: bsnap.workflowId,
            };
            setDraft(next);
            void saveOnly(next);
            showFlash('Banner image added — your email is complete.');
          },
        );
      },
    });
  }, [draft, prepare, chatModel, processBundleText, executeRun, pushChatNote, saveOnly, showFlash]);

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
    // Bounded: in the sandboxed live frame the clipboard write can hang
    // without settling, which used to leave this button with no outcome
    // at all. copyTextBounded always settles, so the user always sees
    // either the Copied state or the blocked-here fallback.
    if (await copyTextBounded(html)) {
      setCopied(true);
      showFlash('HTML copied — paste it into your email tool.');
      setTimeout(() => setCopied(false), 2000);
    } else {
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
  const briefTouched = Boolean(
    brief.purpose ||
      brief.audience ||
      brief.tone ||
      brief.ctaText ||
      brief.ctaUrl ||
      brief.keyPoints.length ||
      brief.senderName ||
      brief.bannerVibe,
  );
  const filledBriefLines = [
    ['Purpose', brief.purpose],
    ['Audience', brief.audience],
    ['Tone', brief.tone],
    ['CTA', [brief.ctaText, brief.ctaUrl].filter(Boolean).join(' · ')],
    ['Key points', brief.keyPoints.join('; ')],
    ['Sender', brief.senderName],
    ['Banner', brief.bannerVibe],
  ].filter(([, v]) => v) as [string, string][];
  // Brief card: full editor while the interview runs; a quiet one-line
  // summary once the package exists (it's reference then, not the task).
  const briefVisible = hasBundle ? (briefOpen ?? false) : true;
  // Drafts are reference once sessions exist: keep the library collapsed
  // unless the user explicitly opens it, including after generation.
  const draftsVisible = draftsOpen ?? false;

  // v0.1.6 fix batch: on a phone the preview is the payoff — it renders
  // directly under the chat card instead of below five other cards.
  // Desktop keeps it in the right column. Exactly one instance mounts.
  const draftRows = draftsLib.drafts.map((d) => (
                    <div key={d.id}>
                      {renamingId === d.id ? (
                        <Group gap="xs" align="center" wrap>
                          <TextInput
                            aria-label="Draft name"
                            data-testid="eb-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.currentTarget.value)}
                            onFocus={(e) => e.currentTarget.select()}
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
                        <>
                          <Group justify="space-between" align="center" wrap>
                            <span style={{ minWidth: 0 }}>
                              {d.name}
                              {d.id === draft.id && (
                                <Badge variant="light" style={{ marginLeft: 6 }}>
                                  editing
                                </Badge>
                              )}
                              <span style={hintStyle}>
                                {' '}
                                · {d.variants.length}{' '}
                                {d.variants.length === 1 ? 'variant' : 'variants'}
                              </span>
                            </span>
                            <Group gap="xs">
                              <Button size="sm" variant="light" onClick={() => void openSavedDraft(d)}>
                                Open
                              </Button>
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenDraftMenu((cur) => (cur === d.id ? null : d.id))
                                }
                                data-testid={`eb-draft-menu-${d.id}`}
                                style={quietToggleStyle}
                                aria-expanded={openDraftMenu === d.id}
                                aria-label={`More actions for ${d.name}`}
                              >
                                ⋯
                              </button>
                            </Group>
                          </Group>
                          {openDraftMenu === d.id && (
                            <Group gap="xs" style={{ marginTop: 6 }} data-testid={`eb-draft-actions-${d.id}`}>
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
                                data-testid={`eb-delete-${d.id}`}
                                onClick={() => void deleteSaved(d.id)}
                              >
                                {deleteArmId === d.id ? 'Confirm delete' : 'Delete'}
                              </Button>
                            </Group>
                          )}
                        </>
                      )}
                    </div>
                    ));

  const previewCard = hasBundle && selectedVariant ? (
        <Card withBorder data-testid="eb-preview">
          <Stack gap="sm">
            <Group justify="space-between" align="center" wrap>
              <strong>Live preview</strong>
              {!narrow && (
                <SegmentedControl
                  size="sm"
                  value={previewWidth}
                  onChange={(v) => setPreviewWidth(v as 'desktop' | 'mobile')}
                  data={[
                    { label: 'Desktop', value: 'desktop' },
                    { label: 'Mobile', value: 'mobile' },
                  ]}
                />
              )}
            </Group>
            <div style={previewFrameStyle}>
              <div
                style={{
                  ...emailCanvasStyle,
                  transition: 'max-width .25s ease',
                  maxWidth: previewWidth === 'desktop' ? '100%' : 360,
                }}
              >
                {draft.bannerUrl && !bannerBroken ? (
                  <img
                    src={draft.bannerUrl}
                    alt="Email banner"
                    data-testid="eb-banner-img"
                    style={bannerImgStyle}
                    referrerPolicy="no-referrer"
                    onError={() => setBannerBroken(true)}
                  />
                ) : (
                  <div style={bannerSlotStyle} data-testid="eb-banner-placeholder">
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
                      <>
                        <span style={bannerSlotTitleStyle}>Your banner image will appear here</span>
                        {selectedVariant.bannerPrompt && (
                          <span style={bannerSlotPromptStyle}>{selectedVariant.bannerPrompt}</span>
                        )}
                        <Button
                          size="sm"
                          onClick={generateBanner}
                          disabled={busy}
                          data-testid="eb-banner-generate-slot"
                        >
                          Generate banner image
                        </Button>
                      </>
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
  ) : null;

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
            {savedSignature === draftSaveSignature(draft) && (
              <span data-testid="eb-saved-status" style={savedStatusStyle}>
                ✓ Saved
              </span>
            )}
          </div>
          <Group gap="sm" align="center" wrap>
            {anon && (
              <Button size="sm" variant="light" onClick={() => requestSignIn()} data-testid="eb-signin">
                Sign in to generate
              </Button>
            )}
          </Group>
        </Group>

        {notice && (
          <Alert color="warning" data-testid="eb-notice">
            {notice}
          </Alert>
        )}
        {flash && (
          <div data-testid="eb-flash" style={flashStyle}>
            ✓ {flash}
          </div>
        )}
        {storageNotice && (
          <Alert color="warning" data-testid="eb-storage-notice">
            {storageNotice}
          </Alert>
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
                  {pending.bannerLeg
                    ? `≈ ${formatBuzz((pending.cost ?? 0) + pending.bannerLeg.flatCost)} total`
                    : pending.costIsCap
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
              {pending.bannerLeg && (
                <div style={{ ...hintStyle, marginTop: 6 }}>
                  Package {formatBuzz(pending.cost)} + banner image {pending.bannerLeg.flatCost}{' '}
                  Buzz (hard cap {pending.bannerLeg.cap}). The banner generates right after the
                  package — no second confirm.
                </div>
              )}
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

        <div
          style={
            narrow ? columnStyle : rowStyle
          }
        >
          {/* LEFT — chat first; brief and drafts join as they gain content */}
          <div style={colStyle}>
            <Stack gap="md">
              <Card withBorder>
                <Stack gap="sm">
                  <Group justify="space-between" align="center">
                    <Group gap="sm" align="center">
                      <span style={chatAvatarStyle} aria-hidden="true">
                        ✉
                      </span>
                      <Stack gap={0}>
                        <strong>Campaign Builder Chat</strong>
                        <span style={{ ...hintStyle, fontSize: 11 }}>
                          {busy ? 'typing…' : 'Replies in seconds'}
                        </span>
                      </Stack>
                    </Group>
                    <Group gap="sm" align="center">
                      {busy && <Badge variant="light">working…</Badge>}
                      <button
                        type="button"
                        onClick={() => setModelOpen((o) => !o)}
                        data-testid="eb-model-toggle"
                        style={quietToggleStyle}
                        aria-expanded={modelOpen}
                      >
                        Model: {CHAT_MODELS.find((m) => m.id === chatModel)?.label} ▾
                      </button>
                    </Group>
                  </Group>
                  <div data-testid="eb-sessions" style={sessionBarStyle}>
                    {sessions.map((sess) => (
                      <Button
                        key={sess.id}
                        size="sm"
                        variant={sess.id === draft.id ? 'light' : 'subtle'}
                        onClick={() => void openSavedDraft(sess)}
                        data-testid={`eb-session-${sess.id}`}
                        title={sess.name}
                        style={{ ...sessionChipStyle, ...(sess.id === draft.id ? selectedChoiceStyle : {}) }}
                      >
                        {sess.name}
                      </Button>
                    ))}
                    <button
                      type="button"
                      onClick={() => void startNewSession()}
                      data-testid="eb-session-new"
                      style={quietToggleStyle}
                    >
                      + New
                    </button>
                    {narrow && draftsLib.drafts.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setDraftsDrawerOpen(true)}
                        data-testid="eb-drafts-open"
                        style={quietToggleStyle}
                        aria-label="Open drafts and templates"
                      >
                        ☰ Drafts
                      </button>
                    )}
                  </div>
                  <div ref={transcriptRef} data-testid="eb-transcript" style={{ ...transcriptStyle, maxHeight: hasBundle ? 300 : 380 }}>
                    {draft.transcript.map((t, i) =>
                      t.widget?.type === 'note' ? (
                        <div key={i} style={noteBubbleStyle}>
                          {t.content}
                        </div>
                      ) : t.widget?.type === 'draft' ? (
                        <Card key={i} withBorder padding="sm" data-testid="eb-draft-widget">
                          <Stack gap="xs">
                            <strong>Your email draft</strong>
                            <span style={hintStyle}>{t.content}</span>
                            <Group gap="xs">
                              {t.widget.variants.map((v) => (
                                <Button
                                  key={v.id}
                                  size="sm"
                                  variant={v.id === draft.selectedVariantId ? 'light' : 'subtle'}
                                  onClick={() =>
                                    setDraft((d) => ({ ...d, selectedVariantId: v.id }))
                                  }
                                  data-testid={`eb-widget-variant-${v.id}`}
                                  style={v.id === draft.selectedVariantId ? selectedChoiceStyle : undefined}
                                >
                                  {v.name}
                                </Button>
                              ))}
                            </Group>
                            <span style={hintStyle}>
                              Subjects, preview, banner & tweaks are in the editor panels.
                            </span>
                          </Stack>
                        </Card>
                      ) : t.role === 'user' ? (
                        <div key={i} style={userBubbleStyle}>
                          {t.content}
                        </div>
                      ) : (
                        <div key={i} style={assistantRowStyle}>
                          <span style={miniAvatarStyle} aria-hidden="true">
                            ✉
                          </span>
                          <div style={assistantBubbleStyle}>{t.content}</div>
                        </div>
                      ),
                    )}
                    {busy && (
                      <div style={assistantRowStyle} data-testid="eb-typing" aria-hidden="true">
                        <span style={miniAvatarStyle}>✉</span>
                        <div style={typingBubbleStyle}>
                          <span className="eb-dot" />
                          <span className="eb-dot" style={{ animationDelay: '0.15s' }} />
                          <span className="eb-dot" style={{ animationDelay: '0.3s' }} />
                        </div>
                      </div>
                    )}
                  </div>
                  {repairOffer && (
                    <Card withBorder data-testid="eb-repair-offer">
                      <Group justify="space-between" align="center" wrap>
                        <span style={hintStyle}>
                          {repairOffer.text ??
                            'I can ask the model to fix its own reply — that’s one more chat charge.'}
                        </span>
                        <Group gap="sm">
                          <Button size="sm" onClick={() => void repairOffer.run()} data-testid="eb-repair-run">
                            {repairOffer.action ?? 'Fix that reply'}
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
                  {modelOpen && (
                  <div>
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
                  </Group>
                  <div style={{ ...hintStyle, marginTop: 4 }}>
                    DeepSeek V4 Flash is the default. The others write differently and
                    price differently per reply.
                  </div>
                  </div>
                  )}
                  {readyToGenerate && !hasBundle && (
                    <Button onClick={generateBundle} disabled={busy} data-testid="eb-next-generate">
                      Brief’s ready — generate my email package →
                    </Button>
                  )}
                  <div style={composerStyle}>
                    <Textarea
                      aria-label="Chat message"
                      data-testid="eb-chat-input"
                      minRows={1}
                      placeholder={
                        hasBundle
                          ? 'Message… e.g. make it shorter, friendlier, add a deadline'
                          : 'Message… describe the email you want to send'
                      }
                      value={input}
                      onChange={(e) => setInput(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendChat();
                        }
                      }}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={sendChat}
                      disabled={!input.trim() || busy}
                      data-testid="eb-send"
                      aria-label={hasBundle ? 'Send revision' : 'Send message'}
                      style={{
                        ...sendBtnStyle,
                        ...(!input.trim() || busy ? sendBtnDisabledStyle : null),
                      }}
                    >
                      ↑
                    </button>
                  </div>
                  <span style={hintStyle}>
                    Enter sends · Shift+Enter for a new line · chat turns cost a little Buzz
                  </span>
                </Stack>
              </Card>

              {narrow && previewCard}

              {briefTouched && (
              <Card withBorder data-testid="eb-brief">
                <Stack gap="xs">
                  <Group justify="space-between" align="center">
                    <strong>Brief</strong>
                    <Group gap="xs" align="center">
                      {readyToGenerate ? (
                        <Badge color="green" variant="light">
                          ready
                        </Badge>
                      ) : (
                        <Badge variant="light">in progress</Badge>
                      )}
                      {hasBundle && (
                        <button
                          type="button"
                          onClick={() => setBriefOpen((o) => !(o ?? false))}
                          data-testid="eb-brief-toggle"
                          style={quietToggleStyle}
                          aria-expanded={briefVisible}
                        >
                          {briefVisible ? 'Hide' : 'Show'}
                        </button>
                      )}
                    </Group>
                  </Group>
                  {!briefVisible ? (
                    <span style={hintStyle}>
                      {brief.purpose
                        ? `${brief.purpose}${brief.audience ? ` — for ${brief.audience}` : ''}`
                        : 'Your brief is saved with this draft.'}
                    </span>
                  ) : !briefTouched ? (
                    <span style={hintStyle}>Your brief will build here as we chat.</span>
                  ) : (
                    filledBriefLines.map(([label, value]) => (
                      <BriefLine key={label} label={label} value={value} />
                    ))
                  )}
                  {!hasBundle && (
                    <Button
                      onClick={generateBundle}
                      disabled={!readyToGenerate || busy}
                      variant="filled"
                      data-testid="eb-generate-bundle"
                      style={!readyToGenerate || busy ? quietDisabledStyle : undefined}
                    >
                      Generate email package
                    </Button>
                  )}
                  {!readyToGenerate && (
                    <span style={hintStyle}>
                      Needs a purpose, an audience, and at least one key point — keep chatting.
                    </span>
                  )}
                </Stack>
              </Card>

              )}

              {!narrow && (draftsLib.drafts.length > 0 || hasBundle) && (
              <Card withBorder data-testid="eb-drafts">
                <Stack gap="xs">
                  <Group justify="space-between" align="center">
                    <strong>Your drafts &amp; templates</strong>
                    {draftsLib.drafts.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setDraftsOpen((o) => !(o ?? false))}
                        data-testid="eb-drafts-toggle"
                        style={quietToggleStyle}
                        aria-expanded={draftsVisible}
                      >
                        {draftsVisible ? 'Hide' : `Show (${draftsLib.drafts.length})`}
                      </button>
                    )}
                  </Group>
                  {draftsVisible && draftRows}
                </Stack>
              </Card>
              )}
            </Stack>
          </div>

          {/* RIGHT — variants, preview, tweaks (arrives with the package) */}
          {hasBundle && (
          <div style={colStyle}>
            <Stack gap="md">
              {hasBundle && selectedVariant ? (
                <>
{!narrow && previewCard}

                  <Card withBorder data-testid="eb-package-options">
                    <Stack gap="sm">
                      <strong>Package options</strong>
                      <span style={hintStyle}>
                        Pick a subject and template. Regenerate only when you want a new set.
                      </span>
                      <span style={sectionLabelStyle}>Subject</span>
                      <Group gap="xs" wrap>
                        {draft.subjects.map((s, i) => (
                          <Button
                            key={i}
                            size="sm"
                            variant={i === subjectIdx ? 'light' : 'subtle'}
                            onClick={() => setSubjectIdx(i)}
                            data-testid={`eb-subject-${i}`}
                            style={i === subjectIdx ? selectedChoiceStyle : undefined}
                          >
                            {s || `Subject ${i + 1}`}
                          </Button>
                        ))}
                      </Group>
                      {draft.preheader && <span style={hintStyle}>Preheader: {draft.preheader}</span>}
                      <span style={sectionLabelStyle}>Template variant</span>
                      <Group gap="xs" wrap>
                        {draft.variants.map((v) => (
                          <Button
                            key={v.id}
                            size="sm"
                            variant={v.id === selectedVariant.id ? 'light' : 'subtle'}
                            onClick={() => setDraft((d) => ({ ...d, selectedVariantId: v.id }))}
                            data-testid={`eb-variant-${v.id}`}
                            style={v.id === selectedVariant.id ? selectedChoiceStyle : undefined}
                          >
                            {v.name}
                          </Button>
                        ))}
                      </Group>
                      <Group gap="sm" align="center" wrap>
                        <Button
                          size="sm"
                          variant="light"
                          onClick={generateBundle}
                          disabled={!readyToGenerate || busy}
                          data-testid="eb-regenerate-package"
                          style={!readyToGenerate || busy ? quietDisabledStyle : undefined}
                        >
                          Regenerate package
                        </Button>
                        <Button
                          size="sm"
                          onClick={generateBanner}
                          disabled={busy || !selectedVariant.bannerPrompt}
                          variant={draft.bannerUrl ? 'light' : 'filled'}
                          data-testid="eb-banner-generate"
                          style={busy || !selectedVariant.bannerPrompt ? quietDisabledStyle : undefined}
                        >
                          {draft.bannerUrl ? 'Regenerate banner' : 'Generate banner'}
                        </Button>
                        <span style={hintStyle}>Nano Banana · up to {BANNER_MAX_BUZZ} Buzz</span>
                      </Group>
                    </Stack>
                  </Card>

                  <Card withBorder data-testid="eb-edit">
                    <Stack gap="sm">
                      <Group justify="space-between" align="center">
                        <strong>Manual tweaks</strong>
                        <button
                          type="button"
                          onClick={() => setEditOpen((o) => !o)}
                          data-testid="eb-edit-toggle"
                          style={quietToggleStyle}
                          aria-expanded={editOpen}
                        >
                          {editOpen ? 'Hide' : 'Edit copy'}
                        </button>
                      </Group>
                      {!editOpen ? (
                        <span style={hintStyle}>
                          Open this only when you want to change copy directly. Chat refinement
                          stays above.
                        </span>
                      ) : (
                        <>
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
                        </>
                      )}
                    </Stack>
                  </Card>
                </>
              ) : (
                <></>
              )}
            </Stack>
          </div>
          )}
        </div>
      </Stack>
      {narrow && draftsDrawerOpen && (
        <div
          style={drawerBackdropStyle}
          onClick={() => setDraftsDrawerOpen(false)}
          data-testid="eb-drafts-drawer"
        >
          <div style={drawerPanelStyle} onClick={(e) => e.stopPropagation()}>
            <Group justify="space-between" align="center" style={{ marginBottom: 10 }}>
              <strong>Your drafts &amp; templates</strong>
              <button
                type="button"
                onClick={() => setDraftsDrawerOpen(false)}
                style={quietToggleStyle}
                aria-label="Close drafts"
              >
                ✕
              </button>
            </Group>
            {draftsLib.drafts.length > 0 ? (
              draftRows
            ) : (
              <span style={hintStyle}>
                No saved drafts yet — your campaigns land here as you work.
              </span>
            )}
          </div>
        </div>
      )}
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

const shellStyle: CSSProperties = { width: '100%', margin: '0 auto', padding: 16 };
/** A disabled primary action must not shout the brand color (v0.1.5). */
const quietDisabledStyle: CSSProperties = {
  background: 'var(--civitai-color-surface-2)',
  color: 'var(--civitai-color-text-dimmed)',
  border: '1px solid var(--civitai-color-border)',
  boxShadow: 'none',
};
const quietToggleStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--civitai-color-text-dimmed)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '2px 4px',
};
const noteBubbleStyle: CSSProperties = {
  alignSelf: 'center',
  maxWidth: '92%',
  fontSize: 12,
  color: 'var(--civitai-color-text-dimmed)',
  background: 'transparent',
  border: '1px dashed var(--civitai-color-border)',
  borderRadius: 10,
  padding: '5px 10px',
  textAlign: 'center',
};
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
/**
 * Full width in EVERY state (v0.1.10). Before v0.1.10 the pre-bundle stage
 * was a 1040px centered column, which read as "not full width" on desktop
 * and ultrawide even though the shell itself was 100% (Zacx's live reports,
 * twice). The chat now owns the whole stage from the first paint.
 */
const selectedChoiceStyle: CSSProperties = {
  background: 'color-mix(in srgb, var(--civitai-color-primary) 14%, transparent)',
  border: '1px solid var(--civitai-color-primary)',
  color: 'var(--civitai-color-primary)',
  boxShadow: 'none',
};
const flashStyle: CSSProperties = {
  alignSelf: 'flex-start',
  fontSize: 12,
  color: 'var(--civitai-color-text)',
  background: 'color-mix(in srgb, var(--civitai-color-success, #40c057) 10%, transparent)',
  border: '1px solid var(--civitai-color-border)',
  borderLeft: '3px solid var(--civitai-color-success, #40c057)',
  borderRadius: 8,
  padding: '6px 10px',
};
const savedStatusStyle: CSSProperties = {
  ...flashStyle,
  marginLeft: 8,
  display: 'inline-flex',
  alignItems: 'center',
  verticalAlign: 'middle',
};
const sectionLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  opacity: 0.72,
};
const sessionBarStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  overflowX: 'auto',
  paddingBottom: 2,
};
const sessionChipStyle: CSSProperties = {
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};
const drawerBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  zIndex: 50,
};
const drawerPanelStyle: CSSProperties = {
  width: 'min(320px, 86vw)',
  height: '100%',
  overflowY: 'auto',
  background: 'var(--civitai-color-surface)',
  borderRight: '1px solid var(--civitai-color-border)',
  padding: 14,
};
const transcriptStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 380,
  overflowY: 'auto',
  padding: '4px 2px',
};
const userBubbleStyle: CSSProperties = {
  alignSelf: 'flex-end',
  maxWidth: '82%',
  padding: '10px 14px',
  borderRadius: '18px 18px 6px 18px',
  background:
    'color-mix(in srgb, var(--civitai-color-primary) 22%, var(--civitai-color-surface-2))',
  border: '1px solid color-mix(in srgb, var(--civitai-color-primary) 45%, transparent)',
  color: 'var(--civitai-color-text)',
  fontSize: 14,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  boxShadow: 'none',
};
const assistantBubbleStyle: CSSProperties = {
  maxWidth: '100%',
  padding: '10px 14px',
  borderRadius: '18px 18px 18px 6px',
  background: 'rgba(128,128,128,0.18)',
  fontSize: 14,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
};
const assistantRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'flex-end',
  alignSelf: 'flex-start',
  maxWidth: '88%',
};
const typingBubbleStyle: CSSProperties = {
  ...assistantBubbleStyle,
  display: 'flex',
  gap: 4,
  alignItems: 'center',
  padding: '12px 14px',
  opacity: 0.75,
};
const chatAvatarStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  borderRadius: '50%',
  background: 'var(--civitai-color-surface-2)',
  border: '1px solid color-mix(in srgb, var(--civitai-color-primary) 55%, transparent)',
  color: 'var(--civitai-color-primary)',
  fontSize: 16,
  flexShrink: 0,
};
const miniAvatarStyle: CSSProperties = {
  ...chatAvatarStyle,
  width: 22,
  height: 22,
  fontSize: 11,
};
const composerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
  padding: '6px 6px 6px 14px',
  borderRadius: 24,
  border: '1px solid var(--civitai-color-border)',
  background: 'var(--civitai-color-surface-2)',
};
const sendBtnStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--civitai-color-primary, #1971c2)',
  color: '#fff',
  fontSize: 17,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const sendBtnDisabledStyle: CSSProperties = {
  background: 'rgba(128,128,128,0.35)',
  cursor: 'default',
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

const bannerSlotStyle: CSSProperties = {
  aspectRatio: '16 / 9',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '20px 24px',
  background: '#eef0f3',
  color: '#55585e',
  borderBottom: '1px solid #e3e5e8',
  textAlign: 'center',
};
const bannerSlotTitleStyle: CSSProperties = { fontSize: 14, fontWeight: 600 };
const bannerSlotPromptStyle: CSSProperties = { fontSize: 12, fontStyle: 'italic', opacity: 0.85 };
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
