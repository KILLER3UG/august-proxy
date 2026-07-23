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

import type { ChatMessage, MessageBlock, WorkbenchBtwState, AppendBlockEvent, ProviderSetupResult } from '@/types/chat';
import type { ChatTurnRecord } from './chat-runtime';
import type { WorkbenchEventHandlers, WorkbenchSession, WorkbenchTurnUsage } from '@/types/workbench';
import type { GitDiffResult } from '@/api/git';
import type { ToolProgressEvent, ToolProgressMap } from '@/lib/tool-progress';
import { applyToolProgress } from '@/lib/tool-progress';
import { classifyTool } from '@/lib/tool-classify';
import { pathBasename } from '@/lib/tool-labels';
import { pushBrowserAction } from '@/lib/browser-store';
import { playReceiveChime } from '@/lib/chat-chime';
import { isNonEmptyPlan, normalizeWorkbenchSession } from '@/lib/workbench-plan';
import { buildCompactionNoticeMessage } from '@/sections/chat/message/CompactionNoticeCard';
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
  const beforeMutationCount = initialMutationCount ?? 0;
  let latestMutationCount = 0;
  let latestWorkbenchTodos: NonNullable<ChatMessage['todos']> = [];
  const thinkingStart = Date.now();
  let thinkingEnd: number | null = null;
  let finished = false;

  // Push the assistant placeholder into message state so the bubble
  // exists from frame 0. Persist to storage so refresh restores it.
  const placeholder: ChatMessage = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
  };
  const nextMessages = [...initialMessages, placeholder];
  setMessages(nextMessages);
  persistMessages(sessionId, nextMessages);
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
    onPrompt: ({ content, systemPrompt, userMessage, tokens, toolUseId, subagentId, jobId }) => {
      const key = toolUseId || (jobId ? `subagent-${jobId}` : `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      setSubagentPrompts(prev => {
        const next = new Map(prev);
        next.set(key, {
          content,
          systemPrompt: systemPrompt ?? '',
          userMessage: userMessage ?? '',
          tokens: tokens ?? 0,
          subagentId: subagentId || undefined,
          jobId: jobId || undefined,
        });
        return next;
      });
      // Also seed the live sub-agent container so the parent tool call
      // can render the nested block immediately, even if a separate
      // `subagentStart` event arrives later (or was missed during a
      // reconnect).
      if (jobId) {
        applySubagentEvent(sessionId, {
          type: 'subagentStart',
          jobId,
          agentId: subagentId || 'subagent',
          parentToolUseId: toolUseId,
        });
      }
    },
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
    onToolResult: ({ id, content, isError, providerSetup }) => {
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
          approved: false,
          approvedAt: null,
          planApproved: false,
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
      const warning = `\n\n⚠️ ${message || 'Warning'}`;
      assistantContent += warning;
      // Append to the live final-answer block instead of pushing a new one:
      // splitProcessAndFinal keeps only the LAST finalOutput block as the
      // "final answer", so a trailing warning block would demote the real
      // answer into the (collapsed) thinking pack and the user would see
      // only the warning rendered as the response.
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: warning });
      scheduleUpdate();
    },
    onInfo: ({ message }) => {
      const info = `\n\nℹ️ ${message || ''}`;
      assistantContent += info;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: info });
      scheduleUpdate();
    },
    onDone: (data) => {
      turnUsage = data?.usage;
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
    onError: ({ message }) => {
      const errText = `\n\n⚠️ Workbench error: ${message}`;
      assistantContent += errText;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: errText });
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
