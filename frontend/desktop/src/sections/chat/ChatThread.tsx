/* eslint-disable react-refresh/only-export-components */

/* ── Chat thread ─────────────────────────────────────────────────────── */
/* Main chat view: message list, plan/approval footer, composer wiring.  */
/* Tool calls render as inline cards. Right rail optional.                 */

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { toast } from 'sonner';
import { UploadCloud } from 'lucide-react';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import {
  useSessionsStore,
  isPlaceholderTitle,
  createSession,
  updateSessionModel,
  updateSessionWorkbenchMetadata,
  resolveActiveSession,
} from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';
import { AnimatePresence } from 'framer-motion';
import { SCROLL_TO_TOP_THRESHOLD } from '@/components/chat/ScrollToTopButton';
import { ModelVisibilityModal } from '@/components/overlays/ModelVisibilityModal';
import { ArenaLaunchModal } from './composer/ArenaLaunchModal';
import { ApprovalBanner } from '@/components/overlays/ApprovalBanner';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { CollaborationInsights } from '@/components/chat/CollaborationInsights';
import { ExamHost } from '@/sections/exam/ExamHost';
import { useQueryClient } from '@tanstack/react-query';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { chatRuntime, type ChatTurnRecord } from './chat-runtime';
import {
  startChatStream,
  stopChatStream,
  syncActiveStreams,
} from './chat-stream-manager';
import { ensureSessionSubscriber } from './stream/session-subscriber';
import {
  useQueuedMessagesStore,
  setQueuedMessages,
  clearQueuedMessages,
  type QueuedUserMessage,
} from './queue-store';
import { buildHandoffSummary, markHandoffPending } from './handoff-summary';
import { SkillEvolvedChip } from '@/components/chat/SkillEvolvedChip';
import { SkillSuggestionChip } from '@/components/chat/SkillSuggestionChip';
import { ComposerDecisionStack } from './ComposerDecisionStack';
import { ChatCheckpoints } from './ChatCheckpoints';
import { useSessionStream } from './hooks/useSessionStream';
import { useStickToBottomScroll } from './hooks/useStickToBottomScroll';
import { useChatModels } from './hooks/useChatModels';
import { useChatUsage } from './hooks/useChatUsage';
import { useChatAttachments } from './hooks/useChatAttachments';
import { useChatSend } from './hooks/useChatSend';
import { useChatVoiceCommands } from './hooks/useChatVoiceCommands';
import { usePlanTurn } from './hooks/usePlanTurn';
import { useChatUiActions } from './hooks/useChatUiActions';
import { useChatMessageActions } from './hooks/useChatMessageActions';
import {
  ChatThreadComposer,
  type ComposerDropdownApi,
} from './ChatThreadComposer';
import {
  createWorkbenchSession,
  answerWorkbenchBtw,
  getWorkbenchSession,
  listWorkbenchCapabilities,
  getQueuedWorkbenchMessages,
  branchWorkbenchSession,
  truncateWorkbenchSession,
} from '@/api/workbench';
import { resolveWorkbenchSessionId } from './stream/session-id-map';
import { launchArenaRun } from './arena/launchArenaRun';
import { ArenaView } from './arena/ArenaView';
import { setDebateRun, type DebateRun as DebateRunType } from './debate/debate-store';
import { DebateView } from './debate/DebateView';
import {
  useOfflineQueueStore,
  dequeueOfflineMessages,
} from './offline-queue-store';
import { WorkbenchBtwDrawer } from '@/components/chat/WorkbenchBtwDrawer';
import {
  WORKBENCH_GUARD_MODES,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { estimateContextBreakdown, type ContextBreakdown } from './ChatComposer';
import { PlanProposalBanner } from '@/components/shell/PlanProposalBanner';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { normalizeWorkbenchSession, shouldShowPlanBanner } from '@/lib/workbench-plan';
import { InitAugCard } from './InitAugCard';
import type { ChatMessage } from '@/types/chat';
import type { WorkbenchSandboxMode } from '@/types/workbench';
export type {
  ChatMessage,
  MessageBlock,
  FileAttachment,
  WorkbenchBtwState,
  WorkbenchMode,
  EffortLevel,
  ChatMessageTodo,
  ChatMessageClarify,
} from '@/types/chat';
import {
  type ModelItem,
  modelFromSession,
  modelDisplayParts,
  getModelDisplayName,
  isLikelyReasoningModel,
  formatContextWindow,
  estimateContextWindow,
} from './model-display';
import {
  loadMessagesForSession as loadMessagesForSessionBase,
  loadComposerDraft,
  persistComposerDraft,
  persistMessages,
} from './message-storage';
import {
  parseSequentialText,
  getDisplayBlocks,
  parseThinkingAndContent,
} from './message-blocks';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatThreadMessagePane } from './ChatThreadMessagePane';

export {
  modelFromSession,
  modelDisplayParts,
  getModelDisplayName,
  isLikelyReasoningModel,
  formatContextWindow,
  parseSequentialText,
  getDisplayBlocks,
  parseThinkingAndContent,
};

const EMPTY_QUEUED_MESSAGES: QueuedUserMessage[] = [];

let visibleSessionId: string | null = null;

function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  return loadMessagesForSessionBase(sessionId);
}

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const navigate = useNavigate();
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSession = useMemo(
    () => resolveActiveSession(sessions, sessionId),
    [sessions, sessionId],
  );

  const {
    messages,
    setMessages,
    subagentPrompts,
    subagentBlocks,
    toolProgress,
    setToolProgress,
    workbenchSession,
    workbenchBtw,
    setWorkbenchSession,
    setWorkbenchBtw,
    setSubagentPrompts,
  } = useSessionStream(sessionId);

  const {
    models,
    visibleModels,
    modelsLoading,
    refetchModels,
    hiddenModels,
    showModelVisibility,
    setShowModelVisibility,
    toggleModelVisibility,
    selectedModel,
    setSelectedModel,
    userSelectedRef,
  } = useChatModels(sessionId, activeSession);

  const {
    attachments,
    attachFiles,
    attachPaths,
    handleFileUpload,
    handleComposerPaste,
    removeAttachment,
    clearAttachments,
    composeText,
    isReading: attachmentsReading,
    readyAttachments,
  } = useChatAttachments();

  const queryClient = useQueryClient();

  // Tauri drag-drop: drop events deliver real filesystem paths (not File
  // objects). Read them via the shell command so attachments preserve
  // their source path — used by tools that need the real file.
  useEffect(() => {
    if (typeof window === 'undefined' || window.__TAURI_INTERNALS__ === undefined) return;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop' || event.payload.paths.length === 0) return;
        void attachPaths(event.payload.paths).then((count) => {
          if (count > 0) {
            toast.message(`Attached ${count} file${count === 1 ? '' : 's'}`);
          }
        });
      });
    });
    return () => {
      unlisten?.();
    };
  }, [attachPaths]);
  const [input, setInput] = useState(() => loadComposerDraft(sessionId));
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(sessionId);
  const [_runtimeVersion, _setRuntimeVersion] = useState(0);
  /** True while files are dragged over the pane — shows the drop overlay. */
  const [dragOver, setDragOver] = useState(false);

  // Backend active-stream map is keyed by workbench SoT id; local turns use the
  // UI session id. OR both so the AUG indicator stays visible across tab/session switches.
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);
  const workbenchStreamId =
    workbenchSession?.id ||
    activeSession?.workbenchSessionId ||
    (sessionId?.startsWith('wb_') ? sessionId : undefined);
  const streaming =
    chatRuntime.isSessionStreaming(sessionId) ||
    (!!workbenchStreamId && chatRuntime.isSessionStreaming(workbenchStreamId)) ||
    !!(sessionId && activeChatSessions[sessionId]) ||
    !!(workbenchStreamId && activeChatSessions[workbenchStreamId]);

  const sessionUsage = useChatUsage(
    sessionId,
    workbenchSession?.id,
    activeSession?.workbenchSessionId,
    // Refresh after each turn so the context ring tracks session fill.
    streaming ? 'streaming' : `idle-${messages.length}`,
  );

  const [workbenchToolCount, setWorkbenchToolCount] = useState<number | null>(null);
  const [workbenchToolTokens, setWorkbenchToolTokens] = useState<number | null>(null);
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchGuardMode>(() => {
    const saved = localStorage.getItem(
      'august_last_workbench_guard_mode',
    ) as WorkbenchGuardMode | null;
    return saved && WORKBENCH_GUARD_MODES[saved] ? saved : 'full';
  });
  // Plan gate UI only when agent mode requires it — Full Access is a hard barrier.
  // Require a real plan object (not {} / boolean presence flags from session summaries).
  // Banner only when the model actually called submit_plan this session
  // (shouldShowPlanBanner requires planSubmittedLive, set by onPlanProposed).
  const planPending =
    workbenchMode !== 'full' && shouldShowPlanBanner(workbenchSession);

  // Command / mutation pre-apply — replaces the composer until Accept/Reject.
  const workbenchSessionId = workbenchSession?.id ?? null;
  const { data: sessionStatus } = useSessionStatus(workbenchSessionId, 5_000);
  // Keep the approval banner up whenever tokens remain — do not require
  // status === awaiting_approval alone (multi-approve used to clear status
  // after the first Accept and hide the rest of the stack).
  // Full access never shows the permission banner (plan gate is already gated).
  const effectiveGuardMode =
    workbenchSession?.guardMode ||
    sessionStatus?.guardMode ||
    workbenchMode;
  const approvalPending =
    effectiveGuardMode !== 'full' &&
    !!workbenchSessionId &&
    (!!sessionStatus?.pendingToken ||
      (Array.isArray(sessionStatus?.pendingMutations) &&
        sessionStatus.pendingMutations.some((m) => !!m?.token)));

  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>(() => {
    try {
      const saved = localStorage.getItem('august_last_effort');
      if (saved && ['low', 'medium', 'high', 'max'].includes(saved)) {
        return saved as 'low' | 'medium' | 'high' | 'max';
      }
    } catch {
      /* silent */
    }
    return 'medium';
  });
  // Session-local: default on; reset to on when switching onto a thinking-capable model.
  const [thinkingEnabled, setThinkingEnabled] = useState(true);

  // Reset thinking toggle when navigating to a different chat session.
  useEffect(() => {
    setThinkingEnabled(true);
  }, [sessionId]);

  const queuedMessages = useQueuedMessagesStore(
    (s) => s.bySession[sessionId ?? ''] ?? EMPTY_QUEUED_MESSAGES,
  );

  const [examActive, setExamActive] = useState(false);
  const [examSeed, setExamSeed] = useState<{ topic?: string; files?: string[] }>({});
  const [augPreview, setAugPreview] = useState<{
    draft: string;
    existing: boolean;
    workspacePath: string;
  } | null>(null);
  const [modelPickerActive, setModelPickerActive] = useState(false);
  /** Prompt for the Compare modal (re-run on 2–3 models side by side). */
  const [comparePrompt, setComparePrompt] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  /** True when content arrived while the user was scrolled up (gates the jump pill). */
  const [hasNewContentWhileUnpinned, setHasNewContentWhileUnpinned] = useState(false);
  /** True while the user is near the bottom — gates stick-to-bottom during stream. */
  const pinnedToBottomRef = useRef(true);
  const messageVirtRef = useRef<{ scrollToIndex: (index: number, opts?: object) => void } | null>(null);
  const mountedRef = useRef(false);

  const NEAR_BOTTOM_PX = 80;

  const composerDropdownRef = useRef<ComposerDropdownApi | null>(null);
  const dropdownClosers = useMemo(
    () => ({
      setShowToolsDropdown: (open: boolean) => {
        composerDropdownRef.current?.setShowToolsDropdown(open);
      },
      setShowCommandsDropdown: (open: boolean) => {
        composerDropdownRef.current?.setShowCommandsDropdown(open);
      },
    }),
    [],
  );

  const {
    getScrollTarget,
    scrollToBottomImmediate,
    programmaticScrollRef,
    setPinned,
  } = useStickToBottomScroll({
    scrollRef,
    pinnedToBottomRef,
    streaming,
    sessionId,
    loadedSessionId,
    messagesVersion: messages,
    onPinnedChange: (pinned) => {
      setScrolledFromBottom(!pinned);
      if (pinned) setHasNewContentWhileUnpinned(false);
    },
  });

  // The jump-to-bottom button snaps instantly: a smooth animation is
  // interrupted by content growth ("stops midway"), and while the viewport is
  // moving the scroll-to-top control can mount/unmount in the same button
  // stack — so a fast second click lands on it and shoots to the top.
  const scrollToBottom = useCallback(() => {
    setScrolledFromBottom(false);
    setHasNewContentWhileUnpinned(false);
    scrollToBottomImmediate();
  }, [scrollToBottomImmediate]);

  // Track pin state from user scrolls only — do not rebind on every stream flush.
  // Re-attach when the message pane mounts (empty → messages); scrollRef is null
  // on the empty-state path so a sessionId-only dep never binds the listener.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages) {
      setScrolledFromBottom(false);
      setScrolledFromTop(false);
      setHasNewContentWhileUnpinned(false);
      return;
    }
    const scrollable = getScrollTarget();
    if (!scrollable) return;
    let raf = 0;
    const check = () => {
      // Ignore stick-to-bottom lerp / snaps — those are not user intent.
      if (programmaticScrollRef.current) return;
      const distanceFromBottom =
        scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight;
      const nearBottom = distanceFromBottom < NEAR_BOTTOM_PX;
      // While a turn is streaming, position tracking may only UNPIN, never
      // re-pin: the smooth-follow lerp's own scroll events land here right
      // after the programmatic guard clears, and re-pinning then dragged the
      // viewport back down the moment the user scrolled up to read. Only an
      // explicit jump-to-bottom (or a new turn) re-pins mid-stream.
      if (streaming && !pinnedToBottomRef.current) {
        setScrolledFromTop(scrollable.scrollTop > SCROLL_TO_TOP_THRESHOLD);
        return;
      }
      // Re-pin only when the user scrolls back near the bottom; upward release
      // is handled immediately by wheel/touch in useStickToBottomScroll.
      setPinned(nearBottom);
      setScrolledFromTop(scrollable.scrollTop > SCROLL_TO_TOP_THRESHOLD);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        check();
      });
    };
    check();
    scrollable.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scrollable.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sessionId, getScrollTarget, hasMessages, programmaticScrollRef, setPinned, streaming]);

  // When unpinned, surface a "↓ New content" pill as the transcript grows.
  const contentVersionRef = useRef(0);
  useEffect(() => {
    contentVersionRef.current = 0;
    setHasNewContentWhileUnpinned(false);
  }, [sessionId]);
  useEffect(() => {
    contentVersionRef.current += 1;
    if (contentVersionRef.current <= 1) return;
    if (!pinnedToBottomRef.current) {
      setHasNewContentWhileUnpinned(true);
    }
  }, [messages, streaming]);

  const isTurnVisible = (turnSessionId: string | null) =>
    mountedRef.current && visibleSessionId === turnSessionId;

  const finishTurn = (turn: ChatTurnRecord, status: 'done' | 'error' | 'aborted' = 'done') => {
    chatRuntime.finishTurn(turn.turnId, status);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setWorkbenchToolCount(null);
      setWorkbenchToolTokens(null);
      return;
    }

    let cancelled = false;
    listWorkbenchCapabilities()
      .then(({ totalTools, toolTokenEstimate }) => {
        if (cancelled) return;
        if (Number.isFinite(totalTools)) setWorkbenchToolCount(totalTools);
        if (Number.isFinite(toolTokenEstimate)) setWorkbenchToolTokens(toolTokenEstimate!);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkbenchToolCount(null);
          setWorkbenchToolTokens(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => chatRuntime.subscribe(() => _setRuntimeVersion((value) => value + 1)), []);

  useEffect(() => {
    visibleSessionId = sessionId;
  }, [sessionId]);

  // modelForRequest needed before useChatSend / ensureWorkbenchSession
  const currentModel = selectedModel || null;
  const modelForRequest = currentModel || modelFromSession(activeSession || null);

  // Latest-value refs so `ensureWorkbenchSession` can keep a STABLE identity
  // (useCallback deps = [sessionId]) while still reading fresh state. Before
  // this, the inline function was recreated every render, and the
  // syncActiveStreams effect re-ran on every render — one extra GET
  // /api/workbench/chat/active plus listener teardown/rebind per stream
  // flush (~32ms), i.e. ~1,800 wasted requests per 60s turn.
  const workbenchSessionRef = useRef(workbenchSession);
  workbenchSessionRef.current = workbenchSession;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const modelForRequestRef = useRef(modelForRequest);
  modelForRequestRef.current = modelForRequest;
  const workbenchModeRef = useRef(workbenchMode);
  workbenchModeRef.current = workbenchMode;

  const ensureWorkbenchSession = useCallback(async () => {
    const workbenchSession = workbenchSessionRef.current;
    const activeSession = activeSessionRef.current;
    if (!sessionId) return null;
    const localTitle = resolveActiveSession(
      useSessionsStore.getState().sessions,
      sessionId,
    )?.title;

    const syncTitleToBackend = (wbId: string, backendTitle?: string) => {
      if (localTitle && !isPlaceholderTitle(localTitle) && isPlaceholderTitle(backendTitle)) {
        void fetch(`/api/workbench/sessions/${encodeURIComponent(wbId)}/title`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: localTitle }),
        }).catch(() => {
          /* best-effort */
        });
      }
    };

    const existingId = workbenchSession?.id || activeSession?.workbenchSessionId;
    if (existingId) {
      try {
        let loaded = await getWorkbenchSession(existingId);
        // Keep sandbox workspace root in sync with the UI folder session.
        const uiWs = activeSession?.workspacePath || '';
        // Correct the backend workspace when it is missing OR stale/wrong — not
        // only when empty. A session switch can leave the workbench session
        // bound to a previous folder (e.g. via workspace-blind draft linking);
        // the per-turn chat body carries no path, so this sync is the only place
        // the UI's folder reaches the backend. The backend invalidates its
        // cached system prompt on this change, so the model and the tools agree.
        if (uiWs && loaded.workspacePath !== uiWs) {
          try {
            const res = await fetch('/api/workbench/sandbox-mode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: loaded.id,
                workspacePath: uiWs,
                sandboxMode: loaded.sandboxMode || 'workspace-write',
              }),
            });
            if (res.ok) loaded = (await res.json()) as typeof loaded;
          } catch {
            /* best-effort */
          }
        }
        const normalized = normalizeWorkbenchSession(loaded) ?? loaded;
        setWorkbenchSession(normalized);
        updateSessionWorkbenchMetadata(sessionId, {
          workbenchSessionId: normalized.id,
          workbenchAgentId: normalized.agentId,
          workbenchProvider: normalized.provider,
        });
        syncTitleToBackend(normalized.id, normalized.title);
        return normalized;
      } catch {
        // Backend may have restarted; create a fresh Workbench session below.
      }
    }

    let sandboxMode: WorkbenchSandboxMode = 'workspace-write';
    let sandboxNetwork: boolean | undefined;
    try {
      const stored = localStorage.getItem('august_last_sandbox_mode');
      sandboxMode =
        stored === 'read-only' || stored === 'workspace-write' || stored === 'danger-full-access'
          ? stored
          : 'workspace-write';
      if (sandboxMode === 'workspace-write' && localStorage.getItem('august_sandbox_network_default') === '1') {
        sandboxNetwork = true;
      }
    } catch {
      /* ignore */
    }
    const created = await createWorkbenchSession({
      provider: modelForRequestRef.current?.provider,
      agentId: WORKBENCH_GUARD_MODES[workbenchModeRef.current].agentId,
      guardMode: workbenchModeRef.current,
      workspacePath: activeSession?.workspacePath || undefined,
      sandboxMode,
      sandboxNetwork,
    });
    const normalizedCreated = normalizeWorkbenchSession(created) ?? created;
    setWorkbenchSession(normalizedCreated);
    updateSessionWorkbenchMetadata(sessionId, {
      workbenchSessionId: normalizedCreated.id,
      workbenchAgentId: normalizedCreated.agentId,
      workbenchProvider: normalizedCreated.provider,
    });
    syncTitleToBackend(normalizedCreated.id, normalizedCreated.title);
    return normalizedCreated;
  }, [sessionId]);

  const { send, generateAIResponse } = useChatSend({
    sessionId,
    loadedSessionId,
    input,
    setInput,
    attachments,
    clearAttachments,
    messages,
    setMessages,
    streaming,
    workbenchSessionId: workbenchSession?.id,
    activeWorkbenchSessionId: activeSession?.workbenchSessionId,
    queuedMessages,
    modelForRequest,
    workbenchMode,
    effort,
    thinkingEnabled,
    ensureWorkbenchSession,
    setShowToolsDropdown: dropdownClosers.setShowToolsDropdown,
    setShowCommandsDropdown: dropdownClosers.setShowCommandsDropdown,
    loadMessagesForSession,
  });

  const { voiceActive, startVoiceInput } = useChatVoiceCommands({
    sessionId,
    messages,
    setMessages,
    setInput,
    clearAttachments,
    attachments,
    workspacePath: activeSession?.workspacePath,
    send,
    setExamActive,
    setExamSeed,
    setAugPreview,
  });

  const {
    handlePlanRevision,
    handlePlanAccept,
    handlePlanAcceptAndImplement,
    handlePlanReject,
    handleMutationContinued,
  } = usePlanTurn({
    sessionId,
    loadedSessionId,
    messages,
    setMessages,
    workbenchSession,
    setWorkbenchSession,
    setSubagentPrompts,
    setToolProgress,
    setWorkbenchBtw,
    setWorkbenchMode,
    isTurnVisible,
    finishTurn,
    loadMessagesForSession,
  });

  const stop = () => {
    if (!sessionId) return;
    const prevModel = selectedModel?.name || selectedModel?.id;
    const summary = buildHandoffSummary(messages, prevModel);
    markHandoffPending(sessionId, summary, selectedModel?.id);
    void stopChatStream(sessionId);
  };

  useChatUiActions({
    sessionId,
    messages,
    setMessages,
    streaming,
    workbenchSession,
    setWorkbenchSession,
    setWorkbenchMode,
    activeSession,
    onStop: stop,
  });

  const {
    revertingIndex,
    handleRevert,
    handleEdit,
    handleRegenerate,
    handleClarifyAnswer,
    confirmState,
    handleConfirm,
    handleCancel,
  } = useChatMessageActions({
    sessionId,
    messages,
    setMessages,
    input,
    setInput,
    streaming,
    generateAIResponse,
  });

  /** Fork the conversation from a message: branch the backend session up to
   *  that index, seed the new UI transcript with the visible prefix, and open
   *  the fork. (Backend index ≈ UI index; after compaction the backend copy
   *  may keep a few extra turns, the UI transcript is always the prefix.) */
  const handleFork = useCallback(
    (index: number) => {
      if (streaming) {
        toast.message('Stop August first, then fork the chat.');
        return;
      }
      const wbId =
        workbenchSessionId ||
        activeSession?.workbenchSessionId ||
        (sessionId?.startsWith('wb_') ? sessionId : null);
      if (!wbId) {
        toast.message('Start a chat first, then fork it.');
        return;
      }
      void branchWorkbenchSession(wbId, index)
        .then((branched) => {
          const ui = createSession(
            activeSession?.folderId ?? null,
            branched.title || 'Chat (fork)',
            activeSession?.workspacePath || null,
          );
          updateSessionWorkbenchMetadata(ui.id, {
            workbenchSessionId: branched.id,
            workbenchAgentId: branched.agentId,
            workbenchProvider: branched.provider,
          });
          persistMessages(ui.id, messages.slice(0, index + 1));
          toast.success('Forked chat — opening the copy…');
          navigate(`/c/${ui.id}`);
        })
        .catch((err: unknown) => {
          toast.error(
            `Could not fork: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    [
      streaming,
      workbenchSessionId,
      activeSession?.workbenchSessionId,
      activeSession?.folderId,
      activeSession?.workspacePath,
      sessionId,
      messages,
    ],
  );

  // Session switch / first load: always land at bottom once messages are ready.
  useLayoutEffect(() => {
    if (!sessionId || loadedSessionId !== sessionId) return;
    setPinned(true);
    scrollToBottomImmediate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on session load
  }, [sessionId, loadedSessionId]);

  // Stick-to-bottom while streaming is handled by useStickToBottomScroll (smooth rAF lerp).
  // Do not force-re-pin when a new turn starts — if the user scrolled up to read, stay put.

  useEffect(() => {
    setInput(loadComposerDraft(sessionId));
    setLoadedSessionId(sessionId);
    if (sessionId) {
      clearQueuedMessages(sessionId);
      getQueuedWorkbenchMessages(sessionId)
        .then((entries) => setQueuedMessages(sessionId, entries))
        .catch((err) => {
          console.warn('[ChatThread] failed to hydrate queue', err);
        });
    }
  }, [sessionId]);

  // Reconnect hydration (bugfix): a turn that finished while the client was
  // disconnected has no SSE replay, so an empty local transcript stays blank.
  // Hydrate once per session from the backend transcript when local storage
  // has nothing — never clobbers a live or locally-restored conversation.
  const hydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || hydratedForRef.current === sessionId) return;
    if (messages.length > 0) return;
    hydratedForRef.current = sessionId;
    let cancelled = false;
    void api
      .get<{ messages: unknown[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      )
      .then((res) => {
        if (cancelled) return;
        const remote = Array.isArray(res?.messages) ? res.messages : [];
        const mapped: ChatMessage[] = [];
        for (const raw of remote) {
          const r = raw as Record<string, unknown>;
          if (!r || typeof r !== 'object') continue;
          const role = String(r.role ?? 'user');
          let content: unknown = r.content;
          // Tool/assistant payloads are stored as dicts {content, tool_calls}.
          if (content && typeof content === 'object') {
            const c = content as Record<string, unknown>;
            content = typeof c.content === 'string' ? c.content : JSON.stringify(c);
          }
          if (!content || String(content).trim() === '') continue;
          mapped.push({
            id: String(r.id ?? `m_remote_${mapped.length}`),
            role: role === 'tool' ? 'assistant' : role,
            content: String(content),
            timestamp: String(r.created_at ?? new Date().toISOString()),
            remote: true,
          } as ChatMessage);
        }
        if (mapped.length === 0) return;
        setMessages((prev) => (prev.length > 0 ? prev : mapped));
        persistMessages(sessionId, mapped);
      })
      .catch(() => {
        /* offline — local storage is the fallback */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    persistComposerDraft(sessionId, input);
  }, [input, sessionId]);

  useEffect(() => {
    try {
      localStorage.setItem('august_last_effort', effort);
    } catch {
      /* silent */
    }
  }, [effort]);

  // When the selected model gains thinking support, default the toggle on.
  const supportsThinking = !!(
    selectedModel?.supportsThinking || selectedModel?.supportsReasoning
  );
  const prevSupportsThinkingRef = useRef(supportsThinking);
  useEffect(() => {
    if (supportsThinking && !prevSupportsThinkingRef.current) {
      setThinkingEnabled(true);
    }
    prevSupportsThinkingRef.current = supportsThinking;
  }, [supportsThinking]);

  useEffect(() => {
    try {
      localStorage.setItem('august_last_workbench_guard_mode', workbenchMode);
    } catch {
      /* silent */
    }
  }, [workbenchMode]);

  // Backend-initiated mode switches (the model calls enter_plan_mode) arrive
  // via guardModeChanged and update only workbenchSession — sync the composer
  // selector so the plan-gate banner can appear. Intentionally keyed on the
  // session mode alone: including workbenchMode would fight in-flight
  // user-initiated switches before the backend round-trip lands.
  const sessionGuardMode = workbenchSession?.guardMode;
  useEffect(() => {
    if (
      sessionGuardMode &&
      WORKBENCH_GUARD_MODES[sessionGuardMode] &&
      sessionGuardMode !== workbenchMode
    ) {
      setWorkbenchMode(sessionGuardMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only when the session mode changes
  }, [sessionGuardMode]);

  useEffect(() => {
    void (async () => {
      try {
        const config = await api.get<Record<string, unknown>>('/api/config/safe');
        const activeProvider = (config?.activeProvider as string) || '';
        const pConfig = (config?.[activeProvider] as Record<string, unknown>) || {};
        const activeModelId: string | null =
          (pConfig?.model as string) ||
          (pConfig?._upstreamModel as string) ||
          (pConfig?.currentModel as string) ||
          null;
        if (activeModelId && activeProvider && !userSelectedRef.current) {
          const placeholder: ModelItem = {
            id: activeModelId,
            name: activeModelId,
            provider: activeProvider,
            contextWindow: estimateContextWindow(activeModelId),
            supportsReasoning: isLikelyReasoningModel(activeModelId),
            supportsThinking: isLikelyReasoningModel(activeModelId),
          };
          setSelectedModel((prev) => {
            // Prefer keeping a catalog-enriched selection; only fall back to the
            // heuristic placeholder when nothing is selected yet.
            if (prev && prev.id === activeModelId) {
              if (
                (prev.supportsReasoning || prev.supportsThinking) ||
                !placeholder.supportsReasoning
              ) {
                return prev;
              }
              return {
                ...prev,
                supportsReasoning: placeholder.supportsReasoning,
                supportsThinking: placeholder.supportsThinking,
              };
            }
            return placeholder;
          });
        }
      } catch (e) {
        console.warn('[Models] Config fetch failed, using localStorage fallback:', e);
      }
    })();
  }, [setSelectedModel, userSelectedRef]);

  useEffect(() => {
    void refetchModels();
  }, [sessionId, refetchModels]);

  const handleRefreshModels = useCallback(async () => {
    await refreshProviderCatalog(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['provider-availability'] });
    void refetchModels();
  }, [queryClient, refetchModels]);

  const prevModelsRef = useRef<ModelItem[]>(models);
  useEffect(() => {
    if (models.length === 0 || models === prevModelsRef.current) return;
    prevModelsRef.current = models;
    setSelectedModel((prev) => {
      const targetId = userSelectedRef.current || prev?.id || null;
      if (!targetId) return models[0];
      const matched = models.find(
        (m) => m.id === targetId || m.id.toLowerCase() === targetId.toLowerCase(),
      );
      if (matched) return matched;
      // Saved selection is not in the freshly-loaded catalog (provider
      // refresh in flight, runtime/environment switch): keep the previous
      // pick instead of silently falling back to models[0] — the saved id
      // rematches once the provider finishes loading.
      return prev ?? null;
    });
  }, [models, setSelectedModel, userSelectedRef]);

  // Model selection from ModelPickerCard — unified with the composer-menu
  // switch path: stop + handoff when streaming, server-computed handoff +
  // notice card for any change, then auto-continue (re-answer the
  // interrupted prompt with the new model). Refs keep the listener stable
  // across re-renders while still reading fresh state when an event fires.
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const chatMessagesRef = useRef(messages);
  chatMessagesRef.current = messages;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const setChatMessagesRef = useRef(setMessages);
  setChatMessagesRef.current = setMessages;
  const generateRef = useRef(generateAIResponse);
  generateRef.current = generateAIResponse;

  useEffect(() => {
    const handleModelSelected = async (e: Event) => {
      const detail = (e as CustomEvent<{ modelId?: string; provider?: string; skipSwitch?: boolean; interrupted?: boolean }>).detail ?? {};
      const { modelId, provider } = detail;
      if (!modelId || !provider) return;
      const model = models.find((m) => m.id === modelId);
      if (!model) return;
      const sid = sessionId;
      const msgs = chatMessagesRef.current;
      const prev = selectedModelRef.current;

      // The composer model menu applies the switch itself and re-dispatches
      // with skipSwitch — only run the shared switch flow when this event is
      // the original (model picker / voice) source.
      if (!detail.skipSwitch) {
        // Shared stop → handoff → apply flow (single source of truth with the
        // composer model menu).
        const { switchChatModel } = await import('./switch-model');
        const { interrupted } = await switchChatModel({
          sessionId: sid,
          prevModel: prev,
          nextModel: model,
          streaming: streamingRef.current,
          stopStream: async () => {
            await stopRef.current();
          },
          getMessages: () => chatMessagesRef.current,
          setMessages: (updater) => setChatMessagesRef.current(updater),
          onModelApplied: (m) => {
            setSelectedModel(m);
            userSelectedRef.current = m.id;
            try {
              localStorage.setItem('august_last_model', JSON.stringify(m));
            } catch {
              /* silent */
            }
            if (sid) updateSessionModel(sid, m.id, m.provider);
            toast.success(`Switched to ${m.name}`);
          },
        });

        // 4) Auto-continue: re-answer the interrupted prompt with the new
        //    model. The backend is truncated at the interrupted turn and the
        //    re-send runs after re-render so the fresh generateAIResponse
        //    closure (new modelForRequest) is used.
        if (interrupted && sid) {
          const lastUserIdx = [...msgs].map((m) => m.role).lastIndexOf('user');
          if (lastUserIdx >= 0) {
            const trimmed = msgs.slice(0, lastUserIdx + 1);
            setChatMessagesRef.current(trimmed);
            const wbId = resolveWorkbenchSessionId(sid);
            void truncateWorkbenchSession(wbId, lastUserIdx).catch(() => undefined);
            // Guard: if the user typed + sent a new message in the interim,
            // do not clobber it with a stale auto-continue of the old prompt.
            const expectedLen = trimmed.length;
            window.setTimeout(() => {
              if (chatMessagesRef.current.length !== expectedLen) return;
              void generateRef.current?.(trimmed);
            }, 0);
          }
        }
        return;
      }

      // skipSwitch: the composer menu already applied the model; only the
      // interrupted-turn auto-continue is requested here.
      if (detail.interrupted && sid) {
        const lastUserIdx = [...msgs].map((m) => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const trimmed = msgs.slice(0, lastUserIdx + 1);
          setChatMessagesRef.current(trimmed);
          const wbId = resolveWorkbenchSessionId(sid);
          void truncateWorkbenchSession(wbId, lastUserIdx).catch(() => undefined);
          const expectedLen = trimmed.length;
          window.setTimeout(() => {
            if (chatMessagesRef.current.length !== expectedLen) return;
            void generateRef.current?.(trimmed);
          }, 0);
        }
      }
    };
    window.addEventListener('august:model-selected', handleModelSelected);
    return () => {
      window.removeEventListener('august:model-selected', handleModelSelected);
    };
  }, [models, sessionId, setSelectedModel, userSelectedRef]);

  useEffect(() => {
    void syncActiveStreams(ensureWorkbenchSession);
    // Debounced resync: rapid focus/visibility churn must not fire a GET +
    // reconnect per event. Reconnect/attach are guarded internally against
    // already-active controllers/subscribers.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const resync = () => {
      if (debounceTimer !== null) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void syncActiveStreams(ensureWorkbenchSession);
      }, 2000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') resync();
    };
    const handleFocus = () => resync();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, [ensureWorkbenchSession, sessionId]);

  // Durable background subscriber: while this session is open and idle,
  // keep a lightweight SSE bound so subagent/browser/queue events that
  // arrive outside an active turn still reach the UI (late subagent
  // completions render here; the subscriber detaches on `started` when a
  // turn takes over). startChatStream/reconnectChatStream detach it while
  // a per-turn stream owns the session; this effect re-attaches when the
  // turn ends and the session goes idle again.
  useEffect(() => {
    if (!sessionId || streaming) return;
    ensureSessionSubscriber(sessionId);
  }, [sessionId, streaming]);

  const maxContext = modelForRequest?.contextWindow && modelForRequest.contextWindow > 0
    ? modelForRequest.contextWindow
    : 128000;
  const toolCountForBreakdown = workbenchToolCount ?? 30;
  const toolTokenEstimate = workbenchToolTokens;
  const serverContextTokens = sessionUsage?.contextTokens ?? 0;
  const hasServerTruth = serverContextTokens > 0;
  const hasContentToSend = input.length > 0 || messages.length > 0;
  const toolOverhead =
    hasServerTruth || hasContentToSend
      ? (toolTokenEstimate ?? Math.ceil(toolCountForBreakdown * 180))
      : 0;
  // Prefer full transcript size (content + thinking + tool payloads), not
  // just message.content — assistant turns often park most tokens in blocks.
  // When blocks exist, use them as the source of truth to avoid double-counting
  // against message.content / thinking mirrors.
  const transcriptChars = messages.reduce((sum, m) => {
    if (m.blocks?.length) {
      let n = 0;
      let hasThinkingBlock = false;
      for (const b of m.blocks) {
        n += b.content?.length ?? 0;
        if (b.type === 'thinking') hasThinkingBlock = true;
        if (b.tool) {
          n += (b.tool.args?.length ?? 0) + (b.tool.preview?.length ?? 0) + (b.tool.summary?.length ?? 0);
        }
      }
      if (!hasThinkingBlock) n += m.thinking?.length ?? 0;
      return sum + n;
    }
    return sum + (m.content?.length ?? 0) + (m.thinking?.length ?? 0);
  }, 0) + input.length;
  const fallbackEstimate = Math.ceil(transcriptChars / 4) + toolOverhead;
  // While a turn is still streaming, server usage is stale — blend the live
  // transcript estimate so the ring moves as the session grows.
  const estTokens = hasServerTruth
    ? streaming
      ? Math.max(serverContextTokens, fallbackEstimate)
      : serverContextTokens
    : fallbackEstimate;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  const contextBreakdown: ContextBreakdown = useMemo(
    () =>
      estimateContextBreakdown({
        messages,
        input,
        toolCount: toolCountForBreakdown,
        toolTokenEstimate: toolTokenEstimate ?? undefined,
        scaleToTotal: hasServerTruth
          ? estTokens
          : hasContentToSend
            ? undefined
            : 0,
      }),
    [
      messages,
      input,
      toolCountForBreakdown,
      toolTokenEstimate,
      hasServerTruth,
      estTokens,
      hasContentToSend,
    ],
  );

  /** "Answer this with another model" (A4): switch the session model and
   *  regenerate the turn — the backend is truncated at that turn by
   *  handleRegenerate, and the deferred call runs after re-render so the
   *  fresh generateAIResponse closure uses the newly selected model. */
  const handleRegenerateRef = useRef(handleRegenerate);
  handleRegenerateRef.current = handleRegenerate;
  const handleReanswerWithModel = useCallback(
    (index: number, model: ModelItem) => {
      if (streaming) return;
      setSelectedModel(model);
      userSelectedRef.current = model.id;
      try {
        localStorage.setItem('august_last_model', JSON.stringify(model));
      } catch {
        /* silent */
      }
      if (sessionId) updateSessionModel(sessionId, model.id, model.provider);
      window.setTimeout(() => {
        handleRegenerateRef.current?.(index);
      }, 0);
    },
    [streaming, sessionId, setSelectedModel, userSelectedRef],
  );

  /** Compare: open the Arena launcher pre-filled with the user prompt that
   *  produced this assistant message — pick 2–3 models, run side by side. */
  const handleCompare = useCallback(
    (index: number) => {
      if (streaming) return;
      for (let i = index - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
          setComparePrompt(m.content);
          return;
        }
      }
      toast.info('No user prompt found before this message');
    },
    [streaming, messages],
  );

  /** Arena ("ask in parallel"): fork the session per target model and send   *  the same prompt to each with a per-turn model override. The split-pane
   *  overlay (ArenaView) streams all lanes side by side; picking a winner
   *  navigates to that lane's session — which holds the full conversation
   *  plus the winning answer, so the chat continues there. */
  const launchArena = useCallback(
    async (targets: ModelItem[], prompt: string) => {
      if (!sessionId || targets.length < 2) return;
      await launchArenaRun({
        sourceSessionId: sessionId,
        prompt,
        targets,
        workbenchMode,
        effort,
        thinkingEnabled,
        folderId: activeSession?.folderId ?? null,
        workspacePath: activeSession?.workspacePath ?? null,
      });
    },
    [
      sessionId,
      workbenchMode,
      effort,
      thinkingEnabled,
      activeSession?.folderId,
      activeSession?.workspacePath,
    ],
  );

  /** Structured debate (A5): two models alternate rounds in THIS chat; an
   *  optional judge summarizes. The overlay orchestrates turns; each round
   *  is a real turn with a per-turn model override. */
  const launchDebate = useCallback(
    (
      a: DebateRunType['models'][number],
      b: DebateRunType['models'][number],
      judge: DebateRunType['models'][number] | null,
      rounds: number,
      prompt: string,
    ) => {
      if (!sessionId) return;
      setDebateRun({
        runId: `debate_${Date.now()}`,
        sessionId,
        prompt,
        models: [a, b],
        judge: judge ?? undefined,
        maxRounds: rounds,
        round: 0,
        phase: 'config',
        auto: true,
        awaitingTurn: false,
        startedAt: Date.now(),
      });
    },
    [sessionId],
  );

  // Offline compose (C9): flush queued messages for this session when the
  // backend is reachable again (also triggered by the banner's "Send now").
  const offlineItems = useOfflineQueueStore((s) => s.items);
  const offlineCount = sessionId
    ? offlineItems.filter((i) => i.sessionId === sessionId).length
    : 0;
  const [flushingOffline, setFlushingOffline] = useState(false);
  const flushOffline = useCallback(async () => {
    if (!sessionId || flushingOffline) return;
    const mine = useOfflineQueueStore
      .getState()
      .items.filter((i) => i.sessionId === sessionId);
    if (mine.length === 0) return;
    setFlushingOffline(true);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch('/api/health', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('backend unhealthy');
    } catch {
      setFlushingOffline(false);
      return;
    }
    const removed = dequeueOfflineMessages(mine.map((i) => i.id));
    for (const item of removed) {
      await send(item.text);
    }
    setFlushingOffline(false);
  }, [sessionId, flushingOffline, send]);

  useEffect(() => {
    if (offlineCount === 0 || flushingOffline) return;
    const timer = setTimeout(() => void flushOffline(), 2000);
    return () => clearTimeout(timer);
  }, [offlineCount, flushingOffline, flushOffline]);

  const composer = (
    <>
      <ComposerDecisionStack
        sessionId={sessionId}
        modelId={selectedModel?.id}
        turnCount={messages.length}
      />
      <ChatThreadComposer
      sessionId={sessionId}
      loadedSessionId={loadedSessionId}
      input={input}
      setInput={setInput}
      attachments={attachments}
      attachmentsReading={attachmentsReading}
      readyAttachmentsCount={readyAttachments.length}
      removeAttachment={removeAttachment}
      handleComposerPaste={handleComposerPaste}
      handleFileUpload={handleFileUpload}
      messages={messages}
      streaming={streaming}
      send={send}
      stop={stop}
      setMessages={setMessages}
      ensureWorkbenchSession={ensureWorkbenchSession}
      queuedMessages={queuedMessages}
      workbenchSession={workbenchSession}
      setWorkbenchSession={setWorkbenchSession}
      workbenchMode={workbenchMode}
      setWorkbenchMode={setWorkbenchMode}
      workspacePath={activeSession?.workspacePath}
      activeWorkbenchSessionId={activeSession?.workbenchSessionId}
      pct={pct}
      estTokens={estTokens}
      maxContext={maxContext}
      contextBreakdown={contextBreakdown}
      sessionUsage={sessionUsage}
      modelForRequest={modelForRequest}
      models={models}
      visibleModels={visibleModels}
      modelsLoading={modelsLoading}
      selectedModel={selectedModel}
      setSelectedModel={setSelectedModel}
      userSelectedRef={userSelectedRef}
      onRefreshModels={() => {
        void handleRefreshModels();
      }}
      onEditModels={() => setShowModelVisibility(true)}
      onArenaLaunch={launchArena}
      onDebateLaunch={launchDebate}
      offlineCount={offlineCount}
      onFlushOffline={() => void flushOffline()}
      effort={effort}
      setEffort={setEffort}
      thinkingEnabled={thinkingEnabled}
      setThinkingEnabled={setThinkingEnabled}
      voiceActive={voiceActive}
      startVoiceInput={startVoiceInput}
      dropdownApiRef={composerDropdownRef}
    />
    </>
  );

  const planBanner = (
    <PlanProposalBanner
      workbenchSession={workbenchSession}
      modelName={selectedModel?.name}
      sending={streaming}
      onOpenPlan={() => {
        addRightDrawerSection('plan');
        window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
      }}
      onAccept={handlePlanAccept}
      onAcceptAndImplement={handlePlanAcceptAndImplement}
      onReject={handlePlanReject}
      onRevise={handlePlanRevision}
    />
  );

  const approvalBanner = (
    <div className="mx-auto w-full max-w-3xl px-4">
      <ApprovalBanner
        sessionId={workbenchSessionId}
        onContinued={(sinceSeq) => {
          void handleMutationContinued(sinceSeq);
        }}
      />
    </div>
  );

  const composerSlot = (
    <div className="august-composer-slot mx-auto w-full max-w-3xl px-4">{composer}</div>
  );

  /** Plan > approval > composer — only one occupies the input slot. */
  const inputSlot = planPending
    ? planBanner
    : approvalPending
      ? approvalBanner
      : composerSlot;

  return (
    <div className="august-chat-thread flex h-full min-h-0 relative w-full">
      <ChatCheckpoints messages={messages} scrollRef={scrollRef} />
      {/* Split-pane arena overlay — null when no run is active. */}
      <ArenaView />
      {/* Debate overlay — null when no debate is active. */}
      <DebateView ensureWorkbenchSession={ensureWorkbenchSession} />
      <div className="august-chat-surface flex-1 flex flex-col min-w-0 bg-chat-area h-full overflow-hidden relative">
        <SkillEvolvedChip />
        <SkillSuggestionChip currentSessionId={workbenchSession?.id || sessionId} />
        <CollaborationInsights />
        {examActive && (
          <ExamHost
            topic={examSeed.topic}
            files={examSeed.files}
            model={
              typeof modelForRequest === 'string'
                ? modelForRequest
                : modelForRequest?.id || ''
            }
            provider={typeof modelForRequest === 'string' ? '' : modelForRequest?.provider || ''}
            onDismiss={() => {
              setExamActive(false);
              setExamSeed({});
            }}
          />
        )}
        {augPreview && (
          <div className="px-4 pt-3">
            <InitAugCard
              draft={augPreview.draft}
              existing={augPreview.existing}
              workspacePath={augPreview.workspacePath}
              sessionId={sessionId ?? undefined}
              onClose={() => setAugPreview(null)}
            />
          </div>
        )}
        {workbenchBtw && (
          <WorkbenchBtwDrawer
            result={workbenchBtw}
            onSend={(question) => {
              if (!sessionId) return;
              void (async () => {
                const active =
                  workbenchSession ||
                  (activeSession?.workbenchSessionId
                    ? {
                        id: activeSession.workbenchSessionId,
                        provider: activeSession.workbenchProvider || '',
                        agentId: activeSession.workbenchAgentId || 'build',
                        agentRole: activeSession.workbenchAgentId || 'build',
                        agentMode: 'assistant',
                        approved: false,
                        approvedAt: null,
                        plan: null,
                        goal: null,
                        lastGoal: null,
                        messageCount: 0,
                        mutationCount: 0,
                        lastMutationAt: null,
                        updatedAt: new Date().toISOString(),
                        todos: [],
                      }
                    : null);
                if (!active) return;
                const result = await answerWorkbenchBtw({
                  sessionId: active.id,
                  question,
                });
                setWorkbenchBtw(result);
              })();
            }}
            onClose={() => setWorkbenchBtw(null)}
          />
        )}
        <div
          className="flex-grow flex flex-col min-h-0 relative"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!dragOver) setDragOver(true);
          }}
          onDragLeave={(e) => {
            // Only clear when the drag leaves the pane, not when it enters a child.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDragOver(false);
            }
          }}
          onDrop={(e) => {
            // Under Tauri the shell's drag-drop event handles drops (it
            // delivers real paths); the browser path would double-attach.
            if (window.__TAURI_INTERNALS__ !== undefined) return;
            const files = e.dataTransfer.files;
            if (!files || files.length === 0) return;
            e.preventDefault();
            setDragOver(false);
            void attachFiles(files);
            toast.message(
              `Attached ${files.length} file${files.length === 1 ? '' : 's'}`,
            );
          }}
        >
          {dragOver && (
            <div
              className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5 backdrop-blur-[1px]"
              aria-hidden
            >
              <div className="flex items-center gap-2 rounded-xl bg-card/90 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg">
                <UploadCloud className="size-4 text-primary" />
                Drop files to attach
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>
            {messages.length === 0 ? (
              <ChatEmptyState
                workspacePath={activeSession?.workspacePath}
                agentMode={workbenchSession?.agentMode}
              >
                {planPending
                  ? planBanner
                  : approvalPending
                    ? (
                      <ApprovalBanner
                        sessionId={workbenchSessionId}
                        onContinued={(sinceSeq) => {
                          void handleMutationContinued(sinceSeq);
                        }}
                      />
                    )
                    : composer}
              </ChatEmptyState>
            ) : (
              <ChatThreadMessagePane
          virtRef={messageVirtRef}
          onBeforeJump={() => setPinned(false)}
                sessionId={sessionId}
                messages={messages}
                streaming={streaming}
                selectedModelId={selectedModel?.id}
                toolProgress={toolProgress}
                subagentPrompts={subagentPrompts}
                subagentBlocks={subagentBlocks}
                revertingIndex={revertingIndex}
                modelPickerActive={modelPickerActive}
                onDismissModelPicker={() => setModelPickerActive(false)}
                scrolledFromTop={scrolledFromTop}
                scrolledFromBottom={scrolledFromBottom}
                showNewContentPill={hasNewContentWhileUnpinned}
                scrollRef={scrollRef}
                onScrollToBottom={scrollToBottom}
                onRevert={handleRevert}
                onEdit={handleEdit}
                onRegenerate={handleRegenerate}
                onFork={handleFork}
                onClarifyAnswer={handleClarifyAnswer}
                models={visibleModels}
                onReanswerWithModel={(model, index) => handleReanswerWithModel(index, model)}
                onCompare={handleCompare}
                footerSlot={inputSlot}
                workbenchSession={workbenchSession}
                pct={pct}
              />
            )}
          </AnimatePresence>
        </div>

        <ModelVisibilityModal
          open={showModelVisibility}
          onClose={() => setShowModelVisibility(false)}
          models={models}
          loading={modelsLoading}
          hiddenModels={hiddenModels}
          onToggleModel={toggleModelVisibility}
          onNavigate={(p) => {
            navigate(p);
          }}
          onRefreshModels={() => {
            void handleRefreshModels();
          }}
        />
        <ConfirmDialog
          open={confirmState.open}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          variant={confirmState.variant}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
        {comparePrompt !== null && (
          <ArenaLaunchModal
            models={visibleModels}
            initialPrompt={comparePrompt}
            onClose={() => setComparePrompt(null)}
            onLaunch={(targets, prompt) => {
              setComparePrompt(null);
              void launchArena(targets, prompt);
            }}
          />
        )}
      </div>
    </div>
  );
}
