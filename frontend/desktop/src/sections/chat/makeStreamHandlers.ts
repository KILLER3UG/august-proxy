/**
 * makeStreamHandlers — factory for the per-turn Workbench SSE handler
 * bundle used by both the composer (`ChatThread.handleSend` →
 * `generateAIResponse`) and the plan banner click handlers
 * (`onAccept` / `onAcceptAndImplement` / `onReject` / `onRevise`).
 *
 * Why a factory (not a hook): each turn is a self-contained stream
 * whose closure state (streamBlocks, toolResults, thinkingContent, …)
 * is created fresh per call and discarded when `finalize()` resolves.
 * A React hook would force this state into refs + useState, adding
 * ceremony and rules-of-hooks pitfalls. A plain factory keeps the
 * closure in scope exactly as the composer originally had it.
 *
 * The factory returns:
 *   - `handlers`: the full `WorkbenchEventHandlers` bundle the SSE
 *     reader passes events to. Every event is rendered into the
 *     chat thread via the same reducer (`appendBlockEvent`) the
 *     composer uses.
 *   - `finalize(status)`: called once when the stream ends (or
 *     errors). Writes the final accumulated state into the
 *     assistant message and updates the session status.
 *   - `getState()`: exposes the live per-turn state for callers
 *     that need it.
 *
 * The factory does NOT start the stream itself. The caller drives
 * the stream and then calls `finalize` exactly once.
 */

import type { ChatMessage, MessageBlock, WorkbenchBtwState, AppendBlockEvent, ProviderSetupResult, IntegrationSetupResult } from '@/types/chat';
import type { ChatTurnRecord } from './chat-runtime';
import type { WorkbenchEventHandlers, WorkbenchSession, WorkbenchTurnUsage } from '@/types/workbench';
import type { GitDiffResult } from '@/api/git';
import type { ToolProgressEvent, ToolProgressMap } from '@/lib/tool-progress';
import { applyToolProgress } from '@/lib/tool-progress';
import { classifyTool } from '@/lib/tool-classify';
import { friendlyError } from '@/lib/error-copy';
import { pathBasename } from '@/lib/tool-labels';
import { pushBrowserAction } from '@/lib/browser-store';
import { playReceiveChime } from '@/lib/chat-chime';
import { getOrInitSessionStreamState } from './stream/session-stream-store';
import { isNonEmptyPlan, normalizeWorkbenchSession } from '@/lib/workbench-plan';
import { buildCompactionNoticeMessage } from '@/sections/chat/message/CompactionNoticeCard';
import { setSessionContextUsed } from './context-used-store';
import { setMemorySuggestions } from './memory-suggestions-store';
import { upsertQueuedMessage, removeQueuedMessage } from './queue-store';
import { resolveUiSessionId, resolveWorkbenchSessionId } from './stream/session-id-map';
import { advanceSessionSubscriberLastSeq } from './stream/session-subscriber';
import { setSubagentProposal } from './subagent-proposals-store';
import { pushNotification } from '@/store/notifications';
import { toast } from 'sonner';
import { useArenaStore } from './arena/arena-store';
import { isDebateSession, debateTurnDone } from './debate/debate-store';
import {
  applySubagentEvent,
  makeSubagentEventHandlers,
} from './stream/apply-subagent-event';
import {
  streamPerfContent,
  streamPerfEnd,
  streamPerfFlush,
  streamPerfStart,
} from '@/lib/stream-perf';

export interface MakeStreamHandlersOptions {
  sessionId: string;
  assistantMsgId: string;
  /** Current messages at turn start. The factory pushes a placeholder
   *  assistant message and returns the new array via `getNextMessages()`. */
  initialMessages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  /** Persist a messages array to durable storage. The factory calls
   *  this on placeholder push and on queue-drain so refresh restores
   *  the right state. */
  persistMessages: (sessionId: string, messages: ChatMessage[]) => void;

  setSessionStatus: (sessionId: string, status: 'idle' | 'working' | 'awaiting' | 'error' | 'done') => void;

  setWorkbenchSession: (
    session:
      | WorkbenchSession
      | null
      | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
  ) => void;
  setSubagentPrompts: React.Dispatch<React.SetStateAction<Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>>>;
  setToolProgress: React.Dispatch<React.SetStateAction<ToolProgressMap>>;
  setWorkbenchBtw: (result: WorkbenchBtwState | null) => void;

  isTurnVisible: (sessionId: string) => boolean;
  finishTurn: (turn: ChatTurnRecord, status: 'done' | 'error' | 'aborted') => void;
  turn: ChatTurnRecord;



  gitApi: { diff: (sessionId: string) => Promise<GitDiffResult> };
  streamUpdateIntervalMs: number;
  initialMutationCount?: number;

  /** Pure reducer that merges a new SSE event into the streamBlocks
   *  array. Lives in ChatThread.tsx so the composer and the factory
   *  share the exact same merging behavior. */
  appendBlockEvent: (prev: MessageBlock[], event: AppendBlockEvent) => MessageBlock[];
}

export interface StreamHandlers {
  handlers: WorkbenchEventHandlers;
  finalize: (status: 'done' | 'error' | 'aborted') => void;
  getState: () => {
    streamBlocks: MessageBlock[];
    assistantContent: string;
    thinkingContent: string;
    toolResults: NonNullable<ChatMessage['tools']>;
    changedFiles: GitDiffResult | null;
  };
}

/** True when the server's context-pressure classification means the window
 *  is actually stressed — high/critical per the backend, or ≥75% used as a
 *  fallback when the classification is missing. Low/medium pressure is a
 *  live meter only (the composer's ContextRing shows the gauge); surfacing
 *  the "nearly full" warning for it is a false alarm on fresh sessions. */
export function isContextPressured(
  attentionPressure: 'low' | 'medium' | 'high' | 'critical' | undefined,
  contextUsedPct?: number,
): boolean {
  if (attentionPressure === 'high' || attentionPressure === 'critical') return true;
  if (attentionPressure === 'low' || attentionPressure === 'medium') return false;
  const pct = Number(contextUsedPct);
  return Number.isFinite(pct) && pct >= 75;
}

export function makeStreamHandlers(opts: MakeStreamHandlersOptions): StreamHandlers {
  const {
    sessionId,
    assistantMsgId,
    initialMessages,
    setMessages,
    persistMessages,
    setSessionStatus,
    setWorkbenchSession,
    setSubagentPrompts,
    setToolProgress,
    setWorkbenchBtw,
    isTurnVisible,
    finishTurn,
    turn,

    gitApi,
    streamUpdateIntervalMs,
    initialMutationCount,
    appendBlockEvent,
  } = opts;

  // Per-turn closure state.
  let assistantContent = '';
  let thinkingContent = '';
  let toolResults: NonNullable<ChatMessage['tools']> = [];
  const pendingConfirmations = new Map<string, { message?: string; detail?: string; confirmationToken?: string }>();
  let streamBlocks: MessageBlock[] = [];
  let changedFiles: GitDiffResult | null = null;
  let turnUsage: WorkbenchTurnUsage | undefined;
  let turnFallback: string | undefined;
  let retryNotice: string | undefined;
  const beforeMutationCount = initialMutationCount ?? 0;
  let latestMutationCount = 0;
  let latestWorkbenchTodos: NonNullable<ChatMessage['todos']> = [];
  const thinkingStart = Date.now();
  let thinkingEnd: number | null = null;
  let finished = false;

  // Push the assistant placeholder into message state so the bubble
  // exists from frame 0. Persist to storage so refresh restores it.
  // MERGE onto the existing store transcript instead of replacing it:
  // callers can pass a trimmed chatHistory (regenerate / model-switch
  // re-answer), and a wholesale replace wipes the whole conversation
  // from view + persistence (audit P0).
  const placeholder: ChatMessage = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
  };
  const prevMessages = getOrInitSessionStreamState(sessionId).messages ?? [];
  const mergedMessages = prevMessages.some((m) => m.id === assistantMsgId)
    ? prevMessages
    : (() => {
        const existingIds = new Set(prevMessages.map((m) => m.id));
        const missing = initialMessages.filter((m) => !existingIds.has(m.id));
        return [...prevMessages, ...missing, placeholder];
      })();
  setMessages(mergedMessages);
  persistMessages(sessionId, mergedMessages);
  setSubagentPrompts(new Map());

  // ---- update / scheduleUpdate (throttled flush to React state) ----
  // streamPerf* marks when localStorage august_stream_perf=1
  streamPerfStart(sessionId);
  let updateTimeout: number | null = null;
  let updateRaf: number | null = null;
  let lastFlushAt = 0;
  const update = () => {
    setMessages(prev => prev.map(msg =>
      msg.id === assistantMsgId ? {
        ...msg,
        content: assistantContent,
        thinking: thinkingContent || undefined,
        tools: toolResults && toolResults.length > 0 ? toolResults : undefined,
        blocks: streamBlocks,
        todos: latestWorkbenchTodos.length > 0 ? latestWorkbenchTodos : undefined,
        changedFiles: changedFiles || undefined,
        usage: turnUsage,
        usedFallback: turnFallback,
        retryNotice,
      } : msg
    ));
  };
  const flushUpdate = () => {
    updateTimeout = null;
    updateRaf = null;
    lastFlushAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    streamPerfFlush(sessionId, update);
  };
  const scheduleFlushOnFrame = () => {
    if (updateRaf !== null) return;
    updateRaf = window.requestAnimationFrame(() => {
      updateRaf = null;
      flushUpdate();
    });
  };
  const scheduleUpdate = () => {
    if (updateTimeout !== null || updateRaf !== null) return;
    // First content for TTFT: any scheduled UI update implies stream content arrived
    streamPerfContent(sessionId);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const delay = Math.max(0, streamUpdateIntervalMs - (now - lastFlushAt));
    // Align paint with the next frame so text + stick-to-bottom scroll land together.
    if (delay <= 0) {
      scheduleFlushOnFrame();
      return;
    }
    updateTimeout = window.setTimeout(() => {
      updateTimeout = null;
      scheduleFlushOnFrame();
    }, delay);
  };
  const cancelPendingUpdate = () => {
    if (updateTimeout !== null) {
      window.clearTimeout(updateTimeout);
      updateTimeout = null;
    }
    if (updateRaf !== null) {
      window.cancelAnimationFrame(updateRaf);
      updateRaf = null;
    }
  };

  const finalize = (status: 'done' | 'error' | 'aborted') => {
    if (finished) return;
    finished = true;
    cancelPendingUpdate();
    streamPerfEnd(sessionId);
    // Reconcile orphaned tools: when the stream ends (abort / crash / backend
    // error) while a tool is still running, its toolResult never arrives.
    // Mark those failed so the card stops spinning instead of loading forever.
    if (toolResults.some((t) => t.status === 'running')) {
      toolResults = toolResults.map((t) =>
        t.status === 'running'
          ? { ...t, status: 'error' as const, error: t.error || 'Tool did not complete (stream ended).' }
          : t,
      );
    }
    setMessages(prev => prev.map(msg =>
      msg.id === assistantMsgId ? {
        ...msg,
        content: assistantContent || msg.content,
        thinking: thinkingContent || undefined,
        thinkingDuration: thinkingEnd
          ? Math.round((thinkingEnd - thinkingStart) / 100) / 10
          : thinkingContent.trim()
            ? Math.round((Date.now() - thinkingStart) / 100) / 10
            : undefined,
        tools: toolResults && toolResults.length > 0 ? toolResults : undefined,
        blocks: streamBlocks,
        todos: latestWorkbenchTodos.length > 0 ? latestWorkbenchTodos : undefined,
        changedFiles: changedFiles || undefined,
        usage: turnUsage,
        usedFallback: turnFallback,
        retryNotice: undefined,
      } : msg
    ));
    if (status === 'done' || status === 'error') {
      if (isTurnVisible(sessionId)) setSessionStatus(sessionId, status === 'done' ? 'done' : 'error');
    }
    // Receive chime when the reply finishes (matches gradient-chat-input).
    if (status === 'done') playReceiveChime();
    finishTurn(turn, status);

  };

  const subagentHandlers = makeSubagentEventHandlers(sessionId);

  const handlers: WorkbenchEventHandlers = {
    // Persist the SSE position so a later reconnect (mid-stream reload, or
    // a backend-started auto-turn) resumes from here instead of replaying
    // from 0 — a from-0 replay stops at the first historical done event and
    // renders nothing new.
    onSeq: (seq: number) => {
      const wbId = resolveWorkbenchSessionId(sessionId);
      if (wbId) advanceSessionSubscriberLastSeq(wbId, seq);
    },
    onSubagentProposed: ({ proposalId, workBreakdown }) => {
      // The model asked for a work breakdown before spawning. Surface it as
      // an inline approval bar above the composer (Launch/Reject post to
      // /api/subagents/propose-breakdown); the Runs tab mirrors the same
      // pending proposals.
      if (!proposalId) return;
      setSubagentProposal(sessionId, { proposalId, workBreakdown });
      const count = Array.isArray(workBreakdown) ? workBreakdown.length : 0;
      toast.message('💡 Sub-agent breakdown proposed', {
        description: count > 0
          ? `${count} agent(s) await your approval — approve or reject above.`
          : 'Approve or reject the breakdown above.',
      });
    },
    // NOTE: the legacy onPrompt handler was removed — the backend never
    // emits 'prompt' events (sub-agent prompts are seeded via
    // subagentStart + the live subagentText/ToolCall/ToolResult stream).
    ...subagentHandlers,
    onStarted: ({ sinceSeq }) => {
      // The backend reports the seq of the 'started' event so callers
      // can attach an SSE subscriber that doesn't replay already-seen
      // events. We don't need to act on it here (the subscriber is
      // independent), but we expose it for debugging via a console hint.
      if (Number.isFinite(sinceSeq)) {
         
        console.debug('[makeStreamHandlers] chat turn started at seq', sinceSeq);
      }
    },
    onThinking: ({ content }) => {
      // Skip empty thinking deltas — they create a visible thinking block
      // with no text content and no way to dismiss it.
      if (!content) return;
      if (!thinkingEnd && content.trim()) {
        thinkingEnd = Date.now();
      }
      thinkingContent += content;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'thinking', content });
      scheduleUpdate();
    },
    onText: ({ content }) => {
      if (!thinkingEnd && thinkingContent.trim()) {
        thinkingEnd = Date.now();
      }
      assistantContent += content;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'finalOutput', content });
      scheduleUpdate();
    },
    onToolUse: ({ id, name, input }) => {
      const existingIdx = toolResults.findIndex(t => t.id === id);
      const toolEntry = {
        name,
        context: JSON.stringify(input || {}, null, 2),
        id,
        status: 'running' as const,
        summary: Object.keys(input || {}).join(', '),
        error: '',
        startedAt: existingIdx !== -1 ? toolResults[existingIdx].startedAt : Date.now(),
      };
      if (existingIdx !== -1) {
        toolResults = toolResults.map((t, idx) => idx === existingIdx ? toolEntry : t);
      } else {
        toolResults = [...toolResults, toolEntry];
      }

      streamBlocks = appendBlockEvent(streamBlocks, {
        type: name.startsWith('@run_command') || name.startsWith('run_command') ? 'command' : 'toolCall',
        name,
        id,
        context: JSON.stringify(input || {}, null, 2),
        status: 'running',
      });
      scheduleUpdate();
    },
    onToolResult: ({ id, content, isError, providerSetup, integrationSetup }) => {
      let parsedResult: Record<string, unknown> | null;
      try {
        parsedResult = typeof content === 'string' ? JSON.parse(content) as Record<string, unknown> : content as Record<string, unknown>;
      } catch {
        parsedResult = null;
      }

      if (parsedResult?.type === 'mutation_pending_confirmation') {
        pendingConfirmations.set(id, {
          message: parsedResult.message as string | undefined,
          detail: parsedResult.detail as string | undefined,
          confirmationToken: parsedResult.confirmationToken as string | undefined,
        });
      } else {
        pendingConfirmations.delete(id);
      }

      const resultText = typeof content === 'string' ? content : content != null ? JSON.stringify(content) : '';

      // Extract search hits from structured web_search JSON result
      let searchHits: Array<{ title: string; url: string; snippet?: string }> | undefined;
      const toolEntry = toolResults.find(t => t.id === id);
      // View/read tools: keep a short metadata summary, never the file body.
      const viewSummary = (() => {
        if (!toolEntry || classifyTool(toolEntry.name) !== 'view') return null;
        try {
          const parsed = toolEntry.context ? JSON.parse(toolEntry.context) as Record<string, unknown> : null;
          const path =
            (typeof parsed?.path === 'string' && parsed.path) ||
            (typeof parsed?.file_path === 'string' && parsed.file_path) ||
            (typeof parsed?.filePath === 'string' && parsed.filePath) ||
            (typeof parsed?.target_file === 'string' && parsed.target_file) ||
            '';
          const lines = resultText ? resultText.split(/\r?\n/).length : 0;
          // Basename only — this summary surfaces in the live-activity line
          // and tool cards, which must never show full absolute paths.
          const shortPath = path ? pathBasename(path) : '';
          if (shortPath && lines > 0) return `${shortPath} · ${lines} line${lines === 1 ? '' : 's'}`;
          if (shortPath) return shortPath;
        } catch {
          /* ignore */
        }
        return 'Read complete';
      })();
      const isCommandResult =
        !!toolEntry &&
        (toolEntry.name.startsWith('run_command') ||
          toolEntry.name.startsWith('@run_command') ||
          toolEntry.name === 'bash' ||
          toolEntry.name.endsWith('__bash'));
      // Commands keep a large output buffer for the live terminal pane;
      // other tools stay compact in the disclosure summary.
      const summaryText =
        viewSummary ??
        (isCommandResult ? resultText.slice(0, 80_000) : resultText.slice(0, 240));
      if (toolEntry && (toolEntry.name === 'web_search' || toolEntry.name === 'WebSearch')) {
        if (parsedResult && Array.isArray(parsedResult.results)) {
          searchHits = (parsedResult.results as Array<{ title?: string; url?: string; snippet?: string }>).map((r) => ({
            title: r.title || r.snippet || '',
            url: r.url || '',
            snippet: r.snippet || '',
          }));
        }
      }

      // Surface setup_provider results so the UI can render an inline key field.
      let providerSetupResult: ProviderSetupResult | undefined;
      if (toolEntry?.name === 'setup_provider' && providerSetup && typeof providerSetup === 'object') {
        providerSetupResult = providerSetup as ProviderSetupResult;
      }
      // Surface integration tool results so the UI can render an inline widget.
      let integrationSetupResult: IntegrationSetupResult | undefined;
      const isIntegrationTool = toolEntry?.name &&
        ['connect_github', 'connect_slack', 'connect_google', 'install_mcp_server'].includes(toolEntry.name);
      if (isIntegrationTool && integrationSetup && typeof integrationSetup === 'object') {
        integrationSetupResult = integrationSetup as IntegrationSetupResult;
      }

      toolResults = toolResults.map(t => t.id === id ? {
        ...t,
        pendingApproval: parsedResult?.type === 'mutation_pending_confirmation' ? {
          message: parsedResult.message as string | undefined,
          detail: parsedResult.detail as string | undefined,
          confirmationToken: parsedResult.confirmationToken as string | undefined,
        } : undefined,
        status: isError && parsedResult?.type !== 'mutation_pending_confirmation' ? 'error' : 'done',
        result: resultText,
        summary: summaryText,
        error: isError && parsedResult?.type !== 'mutation_pending_confirmation' ? resultText : '',
        duration: t.startedAt ? Date.now() - t.startedAt : undefined,
        searchHits: searchHits ?? t.searchHits,
        providerSetup: providerSetupResult ?? t.providerSetup,
        integrationSetup: integrationSetupResult ?? t.integrationSetup,
      } : t);
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: 'toolResult',
        id,
        status: isError && parsedResult?.type !== 'mutation_pending_confirmation' ? 'error' : 'done',
        summary: summaryText,
        error: isError && parsedResult?.type !== 'mutation_pending_confirmation' ? resultText.slice(0, 240) : '',
        duration: toolResults.find(t => t.id === id)?.duration,
        searchHits,
        providerSetup: providerSetupResult,
        integrationSetup: integrationSetupResult,
      });
      scheduleUpdate();
    },
    onSession: (sessionState) => {
      const normalized = normalizeWorkbenchSession(sessionState);
      if (!normalized) return;
      // Session summaries may only carry a boolean plan flag — merge plan
      // from the previous snapshot so we never replace a real plan with {}.
      setWorkbenchSession((prev) => {
        const next = { ...normalized };
        if (!isNonEmptyPlan(next.plan) && isNonEmptyPlan(prev?.plan) && !next.approved) {
          next.plan = prev.plan;
        }
        latestWorkbenchTodos = next.todos ?? [];
        latestMutationCount = next.mutationCount;
        return next;
      });
      scheduleUpdate();
    },
    onRecalledMemories: ({ items }) => {
      if (!items || items.length === 0) return;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'recalledMemories', memories: items });
      scheduleUpdate();
    },
    onMemoryUpdated: ({ action, summary }) => {
      // In-chat notice when August remembered / updated / forgot a memory.
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: 'memoryUpdated',
        summary: summary || `August ${action ?? 'updated'} its memory.`,
      });
      scheduleUpdate();
    },
    onVerifierBlocked: ({ message, evidence }) => {
      // Opt-in verifier enforcement: final answer withheld until the model
      // passes update_state(phase='complete'). Rendered as an amber notice
      // with the gate evidence (phase, blockers, verification command).
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: 'verifierBlocked',
        content: message,
        verifierEvidence: evidence,
      });
      pushNotification('Verification required', message, 'verifier');
      scheduleUpdate();
    },
    onRoutingSuggestion: ({ applied, model, provider, winRate, taskType, currentModel }) => {
      // Evidence-driven routing: when auto-routing applied, this turn is
      // running on a different model than the user picked — say so once
      // (a toast), so the reroute is never a silent surprise.
      if (applied && model && currentModel && currentModel !== model) {
        pushNotification(
          'Auto-routed',
          `This ${taskType || 'task'} was routed from ${currentModel} to ${model} (${Math.round(winRate * 100)}% win rate) — edit in the Reliability dashboard.`,
          'routing',
        );
      }
    },
    onPlanProposed: ({ plan }) => {
      if (!isNonEmptyPlan(plan)) return;
      setWorkbenchSession((prev) => {
        if (!prev) {
          return normalizeWorkbenchSession({
            id: sessionId,
            provider: '',
            agentId: 'plan',
            agentRole: 'plan',
            agentMode: 'assistant',
            approved: false,
            approvedAt: null,
            plan,
            planSubmittedLive: true,
            goal: null,
            lastGoal: null,
            messageCount: 0,
            mutationCount: 0,
            lastMutationAt: null,
            updatedAt: new Date().toISOString(),
            todos: [],
            guardMode: 'plan',
          });
        }
        return {
          ...prev,
          plan,
          planSubmittedLive: true,
          approved: false,
          approvedAt: null,
          planApproved: false,
        };
      });
      scheduleUpdate();
    },
    onGuardModeChanged: ({ guardMode, agentId }) => {
      // Model switched itself into plan mode (enter_plan_mode) — flip the
      // composer chip immediately; the realtime invalidation refetches the
      // full session as a backstop.
      setWorkbenchSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          guardMode: guardMode as typeof prev.guardMode,
          agentId: agentId ?? prev.agentId,
        };
      });
      scheduleUpdate();
    },
    onBrowserAction: (data) => {
      pushBrowserAction({
        id: data.id,
        name: data.name,
        input: data.input,
        url: data.url,
        title: data.title,
        target: data.target ?? null,
        screenshot: data.screenshot ?? null,
        typed: data.typed,
        selected: data.selected,
        scrolled: data.scrolled,
        status: data.status,
        ts: Date.now(),
      });
    },
    onToolProgress: (event) => {
      const e: ToolProgressEvent = {
        id: event.id,
        phase: event.phase,
        paths: event.paths,
        path: event.path,
      };
      setToolProgress(prev => applyToolProgress(prev, e));

      const previewChunk = typeof event.preview === 'string' ? event.preview : '';
      const msg = typeof event.message === 'string' ? event.message.trim() : '';
      if (!event.id || (!previewChunk && !msg)) return;

      const isCommandTool = (name: string) =>
        name.startsWith('run_command') ||
        name.startsWith('@run_command') ||
        name === 'bash' ||
        name.endsWith('__bash');

      // Live shell output → append to preview (do not overwrite summary with noise).
      if (previewChunk) {
        const MAX_PREVIEW = 80_000;
        toolResults = toolResults.map((t) => {
          if (t.id !== event.id || t.status !== 'running') return t;
          const next = (t.preview || '') + previewChunk;
          return {
            ...t,
            preview: next.length > MAX_PREVIEW ? next.slice(next.length - MAX_PREVIEW) : next,
          };
        });
        streamBlocks = appendBlockEvent(streamBlocks, {
          type: 'tool_progress',
          id: event.id,
          status: 'running',
          preview: previewChunk,
        });
        scheduleUpdate();
        return;
      }

      // Status text: for commands keep it off the detail line when preview exists.
      if (msg) {
        toolResults = toolResults.map((t) => {
          if (t.id !== event.id || t.status !== 'running') return t;
          if (isCommandTool(t.name) && t.preview) return t;
          return { ...t, summary: msg };
        });
        streamBlocks = appendBlockEvent(streamBlocks, {
          type: 'tool_progress',
          id: event.id,
          status: 'running',
          summary: msg,
        });
        scheduleUpdate();
      }
    },
    onBtw: (result) => {
      setWorkbenchBtw(result);
    },
    onClarifyProposed: (data) => {
      // Anchor the clarifying question to the assistant message of this turn
      // so the chat thread renders the ClarifyTool popup beneath it.
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMsgId ? { ...msg, clarify: data } : msg
      ));
      scheduleUpdate();
    },
    onUserMessageQueued: (data) => {
      // A follow-up was parked behind the running turn — surface the pill.
      if (!data?.messageId || !data?.sessionId) return;
      upsertQueuedMessage(resolveUiSessionId(data.sessionId), {
        id: data.messageId,
        text: data.text ?? '',
        queuedAt: data.queuedAt ?? new Date().toISOString(),
      });
    },
    onUserMessageDequeued: (data) => {
      if (!data?.messageId || !data?.sessionId) return;
      removeQueuedMessage(resolveUiSessionId(data.sessionId), data.messageId);
    },
    onUserMessageInjected: (data) => {
      // The queued message was drained into the conversation (backend drains
      // in-loop, so it arrives on THIS stream). Drop the pill and render the
      // user bubble BEFORE this turn's assistant bubble — the reply streams
      // into the placeholder id, so ordering would look wrong if appended.
      if (!data?.messageId || !data?.sessionId) return;
      const queueUiId = resolveUiSessionId(data.sessionId);
      removeQueuedMessage(queueUiId, data.messageId);
      const injected: ChatMessage = {
        id: `qm-${data.messageId}`,
        role: 'user',
        content: data.text ?? '',
        timestamp: data.queuedAt ?? new Date().toISOString(),
        queued: true,
      };
      setMessages(prev => {
        // Drop stale "Your message is queued…" placeholder bubbles from a
        // previous queued turn — the message now runs for real.
        const cleaned = prev.filter(msg =>
          !(msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.includes('queued and will run'))
        );
        const idx = cleaned.findIndex(m => m.id === assistantMsgId);
        if (idx >= 0) return [...cleaned.slice(0, idx), injected, ...cleaned.slice(idx)];
        return [...cleaned, injected];
      });
      scheduleUpdate();
    },
    onCompaction: (info) => {
      // Dedicated animated card — don't dump a text blob into the assistant reply.
      const notice = buildCompactionNoticeMessage(info);
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsgId);
        if (idx >= 0) {
          return [...prev.slice(0, idx), notice, ...prev.slice(idx)];
        }
        return [...prev, notice];
      });
      scheduleUpdate();
    },
    onWarning: ({ message }) => {
      const warning = `⚠️ ${message || 'Warning'}`;
      // Push as a THINKING block with system:true — it collapses into the
      // thinking pack but does NOT demote the real final answer.
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'thinking', content: warning, system: true });
      scheduleUpdate();
    },
    onContextPressure: ({ contextUsedPct, attentionPressure, totalTokens, maxContext, remainingTokens }) => {
      // Live-meter event — the backend emits one per turn, not only when the
      // window is nearly full. Only surface the warning when the budget is
      // actually stressed (see isContextPressured); low/medium pressure is a
      // silent no-op and the composer's ContextRing shows the gauge instead.
      if (!isContextPressured(attentionPressure, contextUsedPct)) return;
      const pct = Number(contextUsedPct);
      const label = Number.isFinite(pct) && pct > 0 ? ` (${Math.round(pct)}% used)` : '';
      const detail =
        Number.isFinite(Number(totalTokens)) && Number(remainingTokens) > 0
          ? ` — ${Number(remainingTokens).toLocaleString()} tokens left${Number(maxContext) ? ` of ${Number(maxContext).toLocaleString()}` : ''}`
          : '';
      const warning = `⚠️ Context window nearly full${label}${detail}. Consider compacting or starting a new session.`;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'thinking', content: warning, system: true });
      scheduleUpdate();
    },
    onInfo: ({ message }) => {
      const info = `ℹ️ ${message || ''}`;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'thinking', content: info, system: true });
      scheduleUpdate();
    },
    onRecurringTask: ({ message }) => {
      // Recurring-task daemon (B7): due reminder → bell + toast.
      pushNotification('Reminder', message, 'info');
      toast.message('⏰ Reminder', { description: message });
      scheduleUpdate();
    },
    onDone: (data) => {
      turnUsage = data?.usage;
      turnFallback = data?.usedFallback;
      // Persist the per-turn context snapshot ("what August used") for the
      // composer's context-used badge (backend A5 payload).
      if (sessionId && data?.context) {
        setSessionContextUsed(sessionId, data.context);
      }
      // Proactive memory suggestions ("August noticed…") — one-click save
      // chips above the composer (backend F3 payload).
      if (sessionId && Array.isArray(data?.memorySuggestions)) {
        setMemorySuggestions(sessionId, data.memorySuggestions);
      }
      // Notification center (C1): arena lane completions land in the bell.
      if (sessionId) {
        try {
          const run = useArenaStore.getState().run;
          const lane = run?.lanes.find((l) => l.uiSessionId === sessionId);
          if (lane) {
            pushNotification(`⚔ ${lane.modelName} finished`, undefined, 'arena');
          }
        } catch {
          /* notification is best-effort */
        }
        // Debate mode (A5): advance the round when our initiated turn ends.
        if (isDebateSession(sessionId)) {
          debateTurnDone(sessionId);
        }
      }
      // Finalize FIRST — synchronously capture the complete assistantContent
      // / streamBlocks snapshot before any async work. The old code awaited
      // gitApi.diff() before calling finalize, so a slow/hanging diff fetch
      // delayed the final content write (and the streaming flag flip),
      // leaving the tail of the response unpainted under the streaming mask.
      finalize('done');
      void (async () => {
        if (latestMutationCount > beforeMutationCount && sessionId) {
          try {
            const diff = await gitApi.diff(sessionId);
            if (diff.files.length > 0) {
              changedFiles = diff;
              // Patch the already-finalized message with the changed-files
              // side-panel data (non-critical; the answer is already painted).
              setMessages(prev => prev.map(msg =>
                msg.id === assistantMsgId ? { ...msg, changedFiles } : msg
              ));
            }
          } catch (e) {
            console.warn('[makeStreamHandlers] Failed to load changed files:', e);
          }
        }
      })();
    },
    onRetrying: ({ attempt, maxRetries, delayMs, reason }) => {
      // Self-updating notice (single field, replaced on each attempt) so the
      // user sees the backoff instead of a dead stream. Kept short — the full
      // upstream message is noise once the retry count is visible.
      const shortReason = reason.length > 80 ? `${reason.slice(0, 77)}…` : reason;
      retryNotice = `⏳ ${shortReason} — retrying ${attempt}/${maxRetries} in ${Math.max(1, Math.ceil(delayMs / 1000))}s…`;
      scheduleUpdate();
    },
    onError: ({ message }) => {
      // Real error block (rendered as a red banner with the message-level
      // Retry button), NOT a thinking block — a collapsed disclosure hid
      // failures entirely. The raw upstream text is kept in rawContent and
      // shown inside an expandable details element; content is friendly copy.
      const friendly = friendlyError(message);
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: 'error',
        content: `${friendly.title} — ${friendly.detail}`,
        rawContent: friendly.raw,
        system: true,
      });
      pushNotification('Turn failed', friendly.title, 'error');
      scheduleUpdate();
      finalize('error');
    },
  };

  return {
    handlers,
    finalize,
    getState: () => ({ streamBlocks, assistantContent, thinkingContent, toolResults, changedFiles }),
  };
}
