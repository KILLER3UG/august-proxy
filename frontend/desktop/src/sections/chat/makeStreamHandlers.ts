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

import type { ChatMessage, MessageBlock } from './ChatThread';
import type { WorkbenchEventHandlers, WorkbenchSession } from '@/types/workbench';
import type { GitDiffResult } from '@/api/git';
import type { ToolProgressEvent, ToolProgressMap } from '@/lib/tool-progress';
import { applyToolProgress } from '@/lib/tool-progress';

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

  setWorkbenchSession: (session: WorkbenchSession | null) => void;
  setSubagentPrompts: React.Dispatch<React.SetStateAction<Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>>>;
  setToolProgress: React.Dispatch<React.SetStateAction<ToolProgressMap>>;
  setWorkbenchBtw: (result: any) => void;

  isTurnVisible: (sessionId: string) => boolean;
  finishTurn: (turn: any, status: 'done' | 'error' | 'aborted') => void;
  turn: any;

  queuedMessage: { text: string; attachments: { name: string; size: string }[] } | null;
  setQueuedMessage: React.Dispatch<React.SetStateAction<{ text: string; attachments: { name: string; size: string }[] } | null>>;

  gitApi: { diff: (sessionId: string) => Promise<GitDiffResult> };
  streamUpdateIntervalMs: number;
  initialMutationCount?: number;

  /** Pure reducer that merges a new SSE event into the streamBlocks
   *  array. Lives in ChatThread.tsx so the composer and the factory
   *  share the exact same merging behavior. */
  appendBlockEvent: (prev: MessageBlock[], event: any) => MessageBlock[];
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
    queuedMessage,
    setQueuedMessage,
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
  let beforeMutationCount = initialMutationCount ?? 0;
  let latestMutationCount = 0;
  let latestWorkbenchTodos: any[] = [];
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
  let updateTimeout: number | null = null;
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
      } : msg
    ));
  };
  const flushUpdate = () => {
    updateTimeout = null;
    lastFlushAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    update();
  };
  const scheduleUpdate = () => {
    if (updateTimeout !== null) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const delay = Math.max(0, streamUpdateIntervalMs - (now - lastFlushAt));
    updateTimeout = window.setTimeout(flushUpdate, delay);
  };
  const cancelPendingUpdate = () => {
    if (updateTimeout !== null) {
      window.clearTimeout(updateTimeout);
      updateTimeout = null;
    }
  };

  const finalize = (status: 'done' | 'error' | 'aborted') => {
    if (finished) return;
    finished = true;
    cancelPendingUpdate();
    setMessages(prev => prev.map(msg =>
      msg.id === assistantMsgId ? {
        ...msg,
        content: assistantContent,
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
      } : msg
    ));
    if (status === 'done' || status === 'error') {
      if (isTurnVisible(sessionId)) setSessionStatus(sessionId, status === 'done' ? 'done' : 'error');
    }
    finishTurn(turn, status);

    // Drain the message queue: if the user queued a follow-up while this
    // turn was streaming, append it as a user message. Banner callers pass
    // queuedMessage=null because banner actions never queue; composer
    // callers pass the live state.
    if (queuedMessage && isTurnVisible(sessionId)) {
      const next = queuedMessage;
      setQueuedMessage(null);
      const userMsg: ChatMessage = {
        id: `m${Date.now()}`,
        role: 'user',
        content: next.text,
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => {
        const withQueued = [...prev, userMsg];
        persistMessages(sessionId, withQueued);
        return withQueued;
      });
    }
  };

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
    },
    onThinking: ({ content }) => {
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
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content });
      scheduleUpdate();
    },
    onToolUse: ({ id, name, input }) => {
      toolResults = [...toolResults, {
        name,
        context: JSON.stringify(input || {}, null, 2),
        id,
        status: 'running',
        summary: Object.keys(input || {}).join(', '),
        error: '',
        startedAt: Date.now(),
      }];
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: name.startsWith('@run_command') || name.startsWith('run_command') ? 'command' : 'tool_call',
        name,
        id,
        context: JSON.stringify(input || {}, null, 2),
        status: 'running',
      } as any);
      scheduleUpdate();
    },
    onToolResult: ({ id, content, is_error }) => {
      let parsedResult: any;
      try {
        parsedResult = typeof content === 'string' ? JSON.parse(content) : content;
      } catch {
        parsedResult = null;
      }

      if (parsedResult?.type === 'mutation_pending_confirmation') {
        pendingConfirmations.set(id, {
          message: parsedResult.message,
          detail: parsedResult.detail,
          confirmationToken: parsedResult.confirmationToken,
        });
      } else {
        pendingConfirmations.delete(id);
      }

      const resultText = typeof content === 'string' ? content : JSON.stringify(content);
      toolResults = toolResults.map(t => t.id === id ? {
        ...t,
        pendingApproval: parsedResult?.type === 'mutation_pending_confirmation' ? {
          message: parsedResult.message,
          detail: parsedResult.detail,
          confirmationToken: parsedResult.confirmationToken,
        } : undefined,
        status: is_error && !parsedResult?.type ? 'error' : 'done',
        result: resultText,
        error: is_error && !parsedResult?.type ? resultText : '',
        duration: t.startedAt ? Date.now() - t.startedAt : undefined,
      } : t);
      streamBlocks = appendBlockEvent(streamBlocks, {
        type: 'tool_result',
        id,
        status: is_error && !parsedResult?.type ? 'error' : 'done',
        summary: resultText.slice(0, 240),
        error: is_error && !parsedResult?.type ? resultText.slice(0, 240) : '',
        duration: toolResults.find(t => t.id === id)?.duration,
      });
      scheduleUpdate();
    },
    onSession: (sessionState) => {
      latestWorkbenchTodos = sessionState.todos ?? [];
      latestMutationCount = sessionState.mutationCount;
      setWorkbenchSession(sessionState);
      scheduleUpdate();
    },
    onToolProgress: (event) => {
      const e: ToolProgressEvent = {
        id: event.id,
        phase: event.phase,
        paths: event.paths,
        path: event.path,
      };
      setToolProgress(prev => applyToolProgress(prev, e));
    },
    onBtw: (result) => {
      setWorkbenchBtw(result);
    },
    onCompaction: (info) => {
      // When the summarizing compressor collapses the middle of the
      // conversation, surface a small inline notice so the user can see
      // it happened. The notice is part of the assistant turn so it
      // disappears if the turn is rolled back.
      const notice = `\n\n📦 Context compacted — kept the first ${info.headCount} and last ${info.tailCount} messages; summarized ${info.compressedCount} middle messages (~${info.originalTokens} → ~${info.compressedTokens} tokens).`;
      assistantContent += notice;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: notice });
      scheduleUpdate();
    },
    onDone: async () => {
      if (latestMutationCount > beforeMutationCount && sessionId) {
        try {
          const diff = await gitApi.diff(sessionId);
          if (diff.files.length > 0) changedFiles = diff;
        } catch (e) {
          console.warn('[makeStreamHandlers] Failed to load changed files:', e);
        }
      }
      finalize('done');
    },
    onError: ({ message }) => {
      assistantContent += `\n\n⚠️ Workbench error: ${message}`;
      streamBlocks = appendBlockEvent(streamBlocks, { type: 'text', content: `\n\n⚠️ Workbench error: ${message}` });
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
