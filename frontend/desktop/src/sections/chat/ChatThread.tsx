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
import { mockChatThread } from '@/lib/mock';
import { api } from '@/api/client';
import { toast } from 'sonner';
import {
  useSessionsStore,
  isPlaceholderTitle,
  updateSessionModel,
  updateSessionWorkbenchMetadata,
} from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';
import { AnimatePresence } from 'framer-motion';
import { SCROLL_TO_TOP_THRESHOLD } from '@/components/chat/ScrollToTopButton';
import { ModelVisibilityModal } from '@/components/overlays/ModelVisibilityModal';
import { ApprovalBanner } from '@/components/overlays/ApprovalBanner';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { CollaborationInsights } from '@/components/chat/CollaborationInsights';
import { ExamHost } from '@/sections/exam/ExamHost';
import { useQueryClient } from '@tanstack/react-query';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { chatRuntime, type ChatTurnRecord } from './chat-runtime';
import {
  stopChatStream,
  syncActiveStreams,
} from './chat-stream-manager';
import {
  useQueuedMessagesStore,
  setQueuedMessages,
  clearQueuedMessages,
  type QueuedUserMessage,
} from './queue-store';
import { SavePointBanner } from '@/components/chat/SavePointChip';
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
} from '@/api/workbench';
import { WorkbenchBtwDrawer } from '@/components/chat/WorkbenchBtwDrawer';
import {
  WORKBENCH_GUARD_MODES,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { estimateContextBreakdown, type ContextBreakdown } from './ChatComposer';
import { PlanProposalBanner } from '@/components/shell/PlanProposalBanner';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { hasPendingWorkbenchPlan, normalizeWorkbenchSession } from '@/lib/workbench-plan';
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
  return loadMessagesForSessionBase(sessionId, buildDemoThread);
}

export function ChatThread({ sessionId }: { sessionId: string | null }) {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === sessionId || s.workbenchSessionId === sessionId) ??
      null,
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

  const sessionUsage = useChatUsage(
    sessionId,
    workbenchSession?.id,
    activeSession?.workbenchSessionId,
  );

  const {
    attachments,
    handleFileUpload,
    handleComposerPaste,
    removeAttachment,
    clearAttachments,
    composeText,
    isReading: attachmentsReading,
    readyAttachments,
  } = useChatAttachments();

  const queryClient = useQueryClient();
  const [input, setInput] = useState(() => loadComposerDraft(sessionId));
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(sessionId);
  const [_runtimeVersion, _setRuntimeVersion] = useState(0);

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
  const planPending =
    workbenchMode !== 'full' && hasPendingWorkbenchPlan(workbenchSession);

  // Command / mutation pre-apply — replaces the composer until Accept/Reject.
  const workbenchSessionId = workbenchSession?.id ?? null;
  const { data: sessionStatus } = useSessionStatus(workbenchSessionId, 2000);
  // Keep the approval banner up whenever tokens remain — do not require
  // status === awaiting_approval alone (multi-approve used to clear status
  // after the first Accept and hide the rest of the stack).
  const approvalPending =
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledFromBottom, setScrolledFromBottom] = useState(false);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  /** True while the user is near the bottom — gates stick-to-bottom during stream. */
  const pinnedToBottomRef = useRef(true);
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
    scrollToBottomSmooth: scrollToBottomSmoothRaw,
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
    },
  });

  const scrollToBottomSmooth = useCallback(() => {
    setScrolledFromBottom(false);
    scrollToBottomSmoothRaw();
  }, [scrollToBottomSmoothRaw]);

  // Track pin state from user scrolls only — do not rebind on every stream flush.
  // Re-attach when the message pane mounts (empty → messages); scrollRef is null
  // on the empty-state path so a sessionId-only dep never binds the listener.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages) {
      setScrolledFromBottom(false);
      setScrolledFromTop(false);
      return;
    }
    const scrollable = getScrollTarget();
    if (!scrollable) return;
    const check = () => {
      // Ignore stick-to-bottom lerp / snaps — those are not user intent.
      if (programmaticScrollRef.current) return;
      const distanceFromBottom =
        scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight;
      const nearBottom = distanceFromBottom < NEAR_BOTTOM_PX;
      // Re-pin only when the user scrolls back near the bottom; upward release
      // is handled immediately by wheel/touch in useStickToBottomScroll.
      setPinned(nearBottom);
      setScrolledFromTop(scrollable.scrollTop > SCROLL_TO_TOP_THRESHOLD);
    };
    check();
    scrollable.addEventListener('scroll', check, { passive: true });
    return () => scrollable.removeEventListener('scroll', check);
  }, [sessionId, getScrollTarget, hasMessages, programmaticScrollRef, setPinned]);

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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ensureWorkbenchSession = async () => {
    if (!sessionId) return null;
    const localTitle = useSessionsStore
      .getState()
      .sessions.find((s) => s.id === sessionId || s.workbenchSessionId === sessionId)?.title;

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
        if (uiWs && !loaded.workspacePath) {
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
      provider: modelForRequest?.provider,
      agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
      guardMode: workbenchMode,
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
  };

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

  useChatUiActions({
    sessionId,
    messages,
    setMessages,
    streaming,
    workbenchSession,
    setWorkbenchSession,
    setWorkbenchMode,
    activeSession,
  });

  const {
    revertingIndex,
    handleRevert,
    handleEdit,
    handleRegenerate,
    handleClarifyAnswer,
  } = useChatMessageActions({
    sessionId,
    messages,
    setMessages,
    input,
    setInput,
    streaming,
    generateAIResponse,
  });

  // Session switch / first load: always land at bottom once messages are ready.
  useLayoutEffect(() => {
    if (!sessionId || loadedSessionId !== sessionId) return;
    setPinned(true);
    scrollToBottomImmediate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on session load
  }, [sessionId, loadedSessionId]);

  // New turn starting: re-pin so the reply is visible even if the user had scrolled up.
  const wasStreamingRef = useRef(false);
  useLayoutEffect(() => {
    if (streaming && !wasStreamingRef.current) {
      setPinned(true);
      setScrolledFromBottom(false);
      scrollToBottomImmediate();
    }
    wasStreamingRef.current = streaming;
  }, [streaming, scrollToBottomImmediate, setPinned]);

  // Stick-to-bottom while streaming is handled by useStickToBottomScroll (smooth rAF lerp).

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

  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [messages, sessionId]);

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
            contextWindow: 128000,
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
      return matched || prev || models[0];
    });
  }, [models, setSelectedModel, userSelectedRef]);

  // Model selection from ModelPickerCard
  useEffect(() => {
    const handleModelSelected = (e: Event) => {
      const { modelId, provider } =
        (e as CustomEvent<{ modelId?: string; provider?: string }>).detail ?? {};
      if (!modelId || !provider) return;
      const model = models.find((m) => m.id === modelId);
      if (model) {
        setSelectedModel(model);
        userSelectedRef.current = model.id;
        try {
          localStorage.setItem('august_last_model', JSON.stringify(model));
        } catch {
          /* silent */
        }
        if (sessionId) updateSessionModel(sessionId, modelId, provider);
        toast.success(`Switched to ${model.name}`);
      }
    };
    window.addEventListener('august:model-selected', handleModelSelected);
    return () => {
      window.removeEventListener('august:model-selected', handleModelSelected);
    };
  }, [models, sessionId, setSelectedModel, userSelectedRef]);

  useEffect(() => {
    void syncActiveStreams(ensureWorkbenchSession);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncActiveStreams(ensureWorkbenchSession);
      }
    };
    const handleFocus = () => {
      void syncActiveStreams(ensureWorkbenchSession);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [ensureWorkbenchSession, sessionId]);

  const stop = () => {
    if (sessionId) void stopChatStream(sessionId);
  };

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
  const fallbackEstimate =
    Math.ceil((input.length + messages.reduce((s, m) => s + m.content.length, 0)) / 4) +
    toolOverhead;
  const estTokens = hasServerTruth ? serverContextTokens : fallbackEstimate;
  const pct = Math.min(100, Math.round((estTokens / maxContext) * 100));

  const contextBreakdown: ContextBreakdown = useMemo(
    () =>
      estimateContextBreakdown({
        messages,
        input,
        toolCount: toolCountForBreakdown,
        toolTokenEstimate: toolTokenEstimate ?? undefined,
        scaleToTotal: hasServerTruth
          ? serverContextTokens
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
      serverContextTokens,
      hasContentToSend,
    ],
  );

  const composer = (
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
      effort={effort}
      setEffort={setEffort}
      thinkingEnabled={thinkingEnabled}
      setThinkingEnabled={setThinkingEnabled}
      voiceActive={voiceActive}
      startVoiceInput={startVoiceInput}
      dropdownApiRef={composerDropdownRef}
    />
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
    <div className="mx-auto w-full max-w-3xl px-4">{composer}</div>
  );

  /** Plan > approval > composer — only one occupies the input slot. */
  const inputSlot = planPending
    ? planBanner
    : approvalPending
      ? approvalBanner
      : composerSlot;

  return (
    <div className="flex h-full min-h-0 relative w-full">
      <ChatCheckpoints messages={messages} scrollRef={scrollRef} />
      <div className="flex-1 flex flex-col min-w-0 bg-background h-full overflow-hidden relative">
        <SavePointBanner workbenchSessionId={workbenchSessionId} />
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
        <div className="flex-grow flex flex-col min-h-0 relative">
          <AnimatePresence initial={false}>
            {messages.length === 0 ? (
              <ChatEmptyState workspacePath={activeSession?.workspacePath}>
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
                scrollRef={scrollRef}
                onScrollToBottom={scrollToBottomSmooth}
                onRevert={handleRevert}
                onEdit={handleEdit}
                onRegenerate={handleRegenerate}
                onClarifyAnswer={handleClarifyAnswer}
                footerSlot={inputSlot}
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
            window.location.href = p;
          }}
          onRefreshModels={() => {
            void handleRefreshModels();
          }}
        />
      </div>
    </div>
  );
}

function buildDemoThread(sessionId: string | null): ChatMessage[] {
  if (sessionId !== 'demo') return [];
  return mockChatThread.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    thinking:
      m.role === 'assistant' && m.id === 'm2'
        ? 'The user wants a full React 19 + Tauri 2 refactor. I need to assess the current codebase size, identify key pain points (like the Providers tab bug), and plan a phased migration. Starting with codebase inspection...'
        : m.role === 'assistant' && m.id === 'm3'
          ? 'Found 12 vanilla JS sections, no build step, and a hoisting bug in the Providers tab. The bug is a ReferenceError in init.js caused by loadProviderList being hoisted incorrectly — easy fix but requires careful testing since there are no unit tests.'
          : undefined,
    thinkingDuration:
      m.role === 'assistant' && m.id === 'm2'
        ? 3.4
        : m.role === 'assistant' && m.id === 'm3'
          ? 1.2
          : undefined,
  }));
}
