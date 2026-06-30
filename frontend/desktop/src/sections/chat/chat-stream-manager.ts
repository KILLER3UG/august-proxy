import { atom } from 'nanostores';
import type { ChatMessage, MessageBlock } from './ChatThread';
import type { WorkbenchSession } from '@/types/workbench';
import { streamWorkbenchChat, streamWorkbenchReconnect, stopWorkbenchChat } from '@/api/workbench';
import { setSessionStatus, clearSessionStatus, $sessions } from '@/store/sessions';
import { makeStreamHandlers } from './makeStreamHandlers';
import { gitApi } from '@/api/git';
import { chatRuntime } from './chat-runtime';
import { pushBrowserAction } from '@/lib/browser-store';

export interface SessionStreamState {
  messages: ChatMessage[];
  subagentPrompts: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  /** Live sub-agent containers keyed by the agent job id. Each container
   *  holds its own `blocks` array so thinking/text/tool_call/tool_result
   *  events for the sub-agent are rendered nested under the parent
   *  `august__spawn_subagent` / `august__run_team` tool call. */
  subagentBlocks: Map<string, SubagentBlockState>;
  toolProgress: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  workbenchBtw: any;
  workbenchSession: WorkbenchSession | null;
}

export interface SubagentBlockState {
  id: string;
  jobId: string;
  parentToolId: string;
  agentId: string;
  scope?: string;
  task?: string;
  depth?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  /** Inner blocks (thinking/text/tool_call/tool_result) — same shape as
   *  the parent message's blocks. */
  blocks: MessageBlock[];
  error?: string;
}

// Global store for the stream states of all sessions
export const $sessionStreamStates = atom<Record<string, SessionStreamState>>({});

// Keep track of active fetch AbortControllers on the client
export const activeStreamControllers = new Map<string, AbortController>();

/**
 * Per-session SSE subscriber that holds the live GET /api/workbench/chat/stream
 * connection. Independent of the per-turn AbortController above — detaching
 * this subscriber (e.g. when the user switches sessions) does NOT stop the
 * backend generation; the connection is just closed client-side. Other
 * subscribers (e.g. another tab) can re-attach via `sinceSeq` and replay
 * the missed events from the persistent chat-event-log.
 */
const sessionSubscribers = new Map<string, {
  controller: AbortController;
  lastSeq: number;
}>();

const LAST_SEQ_PREFIX = 'chat_last_seq_';
const SUB_LAST_SEQ = (sessionId: string) => `${LAST_SEQ_PREFIX}${sessionId}`;

function readLastSeq(sessionId: string): number {
  try {
    const raw = localStorage.getItem(SUB_LAST_SEQ(sessionId));
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) { return 0; }
}

function writeLastSeq(sessionId: string, seq: number) {
  if (!Number.isFinite(seq) || seq <= 0) return;
  try { localStorage.setItem(SUB_LAST_SEQ(sessionId), String(seq)); } catch (_) {}
}

const MESSAGES_STORAGE_PREFIX = 'chat_messages_';

const messagesStorageKey = (sessionId: string | null) => sessionId ? `${MESSAGES_STORAGE_PREFIX}${sessionId}` : null;

export function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  const key = messagesStorageKey(sessionId);
  if (!key) return [];

  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
  } catch {}

  return [];
}

export function getOrInitSessionStreamState(sessionId: string | null): SessionStreamState {
  if (!sessionId) {
    return {
      messages: [],
      subagentPrompts: new Map(),
      subagentBlocks: new Map(),
      toolProgress: new Map(),
      workbenchBtw: null,
      workbenchSession: null,
    };
  }

  const current = $sessionStreamStates.get()[sessionId];
  if (current) return current;

  // Initialize from localStorage or defaults
  const initialMessages = loadMessagesForSession(sessionId);

  let workbenchSession: WorkbenchSession | null = null;
  const sessions = $sessions.get();
  const activeSession = sessions.find(s => s.id === sessionId);
  if (activeSession?.workbenchSessionId) {
    workbenchSession = {
      id: activeSession.workbenchSessionId,
      provider: (activeSession.workbenchProvider || 'claude') as any,
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
      guardMode: 'full',
    };
  }

  const state: SessionStreamState = {
    messages: initialMessages,
    subagentPrompts: new Map(),
    subagentBlocks: new Map(),
    toolProgress: new Map(),
    workbenchBtw: null,
    workbenchSession,
  };

  $sessionStreamStates.set({
    ...$sessionStreamStates.get(),
    [sessionId]: state,
  });

  return state;
}

export function updateSessionStreamState(
  sessionId: string,
  updater: (prev: SessionStreamState) => Partial<SessionStreamState>
) {
  const current = getOrInitSessionStreamState(sessionId);
  const next = { ...current, ...updater(current) };
  $sessionStreamStates.set({
    ...$sessionStreamStates.get(),
    [sessionId]: next,
  });
}

function persistMessages(sessionId: string, messages: ChatMessage[]) {
  try {
    localStorage.setItem(`chat_messages_${sessionId}`, JSON.stringify(messages));
  } catch {}
}

// Check if we are currently streaming a session
export function isSessionStreaming(sessionId: string | null): boolean {
  if (!sessionId) return false;
  return activeStreamControllers.has(sessionId);
}

// Start a new chat generation
export async function startChatStream(
  sessionId: string,
  params: {
    message: string;
    chatHistory: ChatMessage[];
    workbenchMode: any;
    effort: any;
    model: string | undefined;
    modelProvider: string | undefined;
    getWorkbenchProvider: () => 'claude' | 'codex';
    ensureWorkbenchSession: () => Promise<any>;
  }
) {
  if (activeStreamControllers.has(sessionId)) {
    if (chatRuntime.isSessionStreaming(sessionId)) {
      return;
    }
    activeStreamControllers.delete(sessionId);
  }

  setSessionStatus(sessionId, 'working');

  const assistantMsgId = `a${Date.now()}`;
  const abortController = new AbortController();
  activeStreamControllers.set(sessionId, abortController);

  const turn = chatRuntime.startTurn({
    sessionId,
    assistantMsgId,
    transport: 'none',
  });

  const { handlers, finalize } = makeStreamHandlers({
    sessionId,
    assistantMsgId,
    initialMessages: params.chatHistory,
    setMessages: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextMsgs = typeof updater === 'function' ? (updater as any)(prev.messages) : updater;
        persistMessages(sessionId, nextMsgs);
        return { messages: nextMsgs };
      });
    },
    persistMessages,
    setSessionStatus,
    setWorkbenchSession: (session) => {
      updateSessionStreamState(sessionId, () => ({ workbenchSession: session }));
    },
    setSubagentPrompts: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextPrompts = typeof updater === 'function' ? (updater as any)(prev.subagentPrompts) : updater;
        return { subagentPrompts: nextPrompts };
      });
    },
    setToolProgress: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextProgress = typeof updater === 'function' ? (updater as any)(prev.toolProgress) : updater;
        return { toolProgress: nextProgress };
      });
    },
    setWorkbenchBtw: (btw) => {
      updateSessionStreamState(sessionId, () => ({ workbenchBtw: btw }));
    },
    isTurnVisible: () => true,
    finishTurn: (t, status) => {
      chatRuntime.finishTurn(t.turnId, status);
      activeStreamControllers.delete(sessionId);
    },
    turn,
    gitApi,
    streamUpdateIntervalMs: 24,
    appendBlockEvent,
  });

  try {
    const session = await params.ensureWorkbenchSession();
    if (!session) {
      updateSessionStreamState(sessionId, prev => ({
        messages: prev.messages.map(msg =>
          msg.id === assistantMsgId ? { ...msg, content: '⚠️ Could not initialize Workbench session.' } : msg
        )
      }));
      finalize('error');
      activeStreamControllers.delete(sessionId);
      return;
    }

    chatRuntime.setTransport(turn.turnId, 'http');

    const startResult = await streamWorkbenchChat({
      sessionId: session.id,
      message: params.message,
      provider: params.getWorkbenchProvider(),
      effort: params.effort,
      model: params.model,
      modelProvider: params.modelProvider,
    }, handlers, abortController.signal);

    // The POST handler returns { sinceSeq } JSON immediately and runs the
    // generation in the background. Live events are delivered via the
    // separate /api/workbench/chat/stream SSE channel — attach it now using
    // the same per-turn handlers so streamed text / thinking / tool_use /
    // tool_result events reach the chat UI. Without this, events accumulate
    // in the chat-event-log unread and the assistant bubble stays empty.
    //
    // Always attach the SSE subscriber when the POST didn't already consume
    // the event stream (legacy SSE POST body path sets consumedViaPost=true).
    // The backend handles missing/undefined sinceSeq by starting from the
    // current event log position.
    if (startResult?.consumedViaPost) {
      // Events were already delivered through the POST response body
      // (older backend / proxy without the JSON sinceSeq contract).
    } else {
      const reconnectSinceSeq = Number.isFinite(startResult?.sinceSeq)
        ? startResult!.sinceSeq
        : undefined;
      if (reconnectSinceSeq === undefined) {
        console.warn('[startChatStream] POST succeeded without a valid sinceSeq — reconnecting from current position as fallback');
      }
      await streamWorkbenchReconnect(
        session.id,
        handlers,
        abortController.signal,
        reconnectSinceSeq
      );
    }

    finalize(abortController.signal.aborted ? 'aborted' : 'done');
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      clearSessionStatus(sessionId);
      finalize('aborted');
      return;
    }
    console.error('[startChatStream] error:', e);
    const errorMsg = e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Unknown error';
    updateSessionStreamState(sessionId, prev => ({
      messages: prev.messages.map(msg =>
        msg.id === assistantMsgId
          ? { ...msg, content: (msg.content || '') + `\n\n⚠️ Could not generate a response: ${errorMsg}` }
          : msg
      )
    }));
    // Also emit an error event through the handler so the onError path
    // in makeStreamHandlers can write the ⚠️ block into streamBlocks.
    try { handlers.onError?.({ message: errorMsg }); } catch {}
    finalize('error');
  } finally {
    activeStreamControllers.delete(sessionId);
  }
}

// Stop/abort generation for a session
export async function stopChatStream(sessionId: string) {
  const controller = activeStreamControllers.get(sessionId);
  if (controller) {
    controller.abort();
    activeStreamControllers.delete(sessionId);
  }

  const activeTurnId = chatRuntime.getLatestActiveTurnId(sessionId);
  const turn = activeTurnId ? chatRuntime.getTurn(activeTurnId) : null;
  if (turn) {
    chatRuntime.abortTurn(turn.turnId);
  }

  clearSessionStatus(sessionId);

  // Tell the backend to stop
  try {
    const state = getOrInitSessionStreamState(sessionId);
    const wbSessionId = state.workbenchSession?.id || sessionId;
    await stopWorkbenchChat(wbSessionId);
  } catch (err) {
    console.warn('Failed to notify backend of stop:', err);
  }
}

// Reconnect/sync stream with the backend
export async function reconnectChatStream(
  sessionId: string,
  ensureWorkbenchSession: () => Promise<any>
) {
  if (activeStreamControllers.has(sessionId)) {
    // Already active
    return;
  }

  const state = getOrInitSessionStreamState(sessionId);
  const messages = state.messages;
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const initialMessages = lastUserIdx !== -1 ? messages.slice(0, lastUserIdx + 1) : messages;

  let assistantMsgId = '';
  if (lastUserIdx !== -1 && lastUserIdx + 1 < messages.length) {
    assistantMsgId = messages[lastUserIdx + 1].id;
  } else {
    assistantMsgId = `a${Date.now()}`;
  }

  const turn = chatRuntime.startTurn({
    sessionId,
    assistantMsgId,
    transport: 'none',
  });

  // Use the turn's controller so aborting the turn also cancels fetches.
  const abortController = turn.controller;
  activeStreamControllers.set(sessionId, abortController);

  const { handlers, finalize } = makeStreamHandlers({
    sessionId,
    assistantMsgId,
    initialMessages,
    setMessages: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextMsgs = typeof updater === 'function' ? (updater as any)(prev.messages) : updater;
        persistMessages(sessionId, nextMsgs);
        return { messages: nextMsgs };
      });
    },
    persistMessages,
    setSessionStatus,
    setWorkbenchSession: (session) => {
      updateSessionStreamState(sessionId, () => ({ workbenchSession: session }));
    },
    setSubagentPrompts: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextPrompts = typeof updater === 'function' ? (updater as any)(prev.subagentPrompts) : updater;
        return { subagentPrompts: nextPrompts };
      });
    },
    setToolProgress: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextProgress = typeof updater === 'function' ? (updater as any)(prev.toolProgress) : updater;
        return { toolProgress: nextProgress };
      });
    },
    setWorkbenchBtw: (btw) => {
      updateSessionStreamState(sessionId, () => ({ workbenchBtw: btw }));
    },
    isTurnVisible: () => true,
    finishTurn: (t, status) => {
      chatRuntime.finishTurn(t.turnId, status);
      activeStreamControllers.delete(sessionId);
    },
    turn,
    gitApi,
    streamUpdateIntervalMs: 24,
    appendBlockEvent,
  });

  try {
    chatRuntime.setTransport(turn.turnId, 'http');

    const lastSeq = getSessionSubscriberLastSeq(sessionId);
    await streamWorkbenchReconnect(sessionId, handlers, abortController.signal, lastSeq || undefined);
    finalize(abortController.signal.aborted ? 'aborted' : 'done');
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      clearSessionStatus(sessionId);
      finalize('aborted');
      return;
    }
    console.warn('Reconnect error:', e);
    finalize('done');
  } finally {
    activeStreamControllers.delete(sessionId);
  }
}

// Sync all active streams with the backend
export async function syncActiveStreams(ensureWorkbenchSession: () => Promise<any>) {
  try {
    const res = await fetch('/api/workbench/chat/active');
    if (!res.ok) return;
    const active: Record<string, string> = await res.json();
    for (const sessionId of Object.keys(active)) {
      if (active[sessionId] === 'streaming') {
        // Re-attach the per-session SSE subscriber if we don't have one.
        // The subscriber is independent of any per-turn AbortController —
        // it stays attached across tab/session switches and only detaches
        // when the backend reports the turn finished or the SSE closes.
        ensureSessionSubscriber(sessionId);
      }
    }
  } catch (err) {
    console.warn('Failed to sync active streams:', err);
  }
}

/**
 * Attach (or re-attach) the per-session SSE subscriber that pulls events
 * from GET /api/workbench/chat/stream. The subscriber is idempotent: if
 * one is already attached for `sessionId` it is left alone. The reducer
 * updates `subagentBlocks` (so background sub-agents appear in the chat
 * thread even when no per-turn handler is active) and bumps the stored
 * `lastSeq` so subsequent reconnects don't replay events.
 */
export function ensureSessionSubscriber(sessionId: string): void {
  if (!sessionId) return;
  if (sessionSubscribers.has(sessionId)) return;

  // Ensure there is an active turn in chatRuntime so the AUG streaming
  // indicator (WorkingIndicator) shows while the backend is generating.
  // Without this, a previous turn may have been finalized when the original
  // SSE connection dropped (tab switch, throttling), leaving isSessionStreaming
  // false even though the backend is still actively streaming and reconnecting
  // via this subscriber.
  let dummyTurnId: string | null = null;
  if (!chatRuntime.isSessionStreaming(sessionId)) {
    const assistantMsgId = `subscriber-${sessionId}-${Date.now()}`;
    const turn = chatRuntime.startTurn({
      sessionId,
      assistantMsgId,
      transport: 'none',
    });
    dummyTurnId = turn.turnId;
  }

  const controller = new AbortController();
  const sinceSeq = readLastSeq(sessionId);
  const entry = { controller, lastSeq: sinceSeq };
  sessionSubscribers.set(sessionId, entry);

  const handlers: import('@/types/workbench').WorkbenchEventHandlers = {
    onSeq: (seq) => {
      if (seq > entry.lastSeq) {
        entry.lastSeq = seq;
        writeLastSeq(sessionId, seq);
      }
    },
    onSubagentStart: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagent_start',
        jobId: data.jobId,
        agentId: data.agentId,
        parentToolUseId: data.parentToolUseId,
        scope: data.scope,
        task: data.task,
        depth: data.depth,
      });
    },
    onSubagentDone: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagent_done',
        jobId: data.jobId,
        status: data.status,
        message: data.message,
        result: data.result,
      });
    },
    onSubagentText: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagent_text',
        jobId: data.jobId,
        content: data.content || '',
      });
    },
    onSubagentToolCall: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagent_tool_call',
        jobId: data.jobId,
        id: data.id,
        name: data.name,
        input: data.input,
        status: data.status || 'running',
      });
    },
    onSubagentToolResult: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagent_tool_result',
        jobId: data.jobId,
        id: data.id,
        content: data.content,
        is_error: data.is_error,
      status: data.status || (data.is_error ? 'error' : 'done'),
        });
      },
      onCompaction: (_data) => {
        // Compaction events are handled by the per-turn handler
        // (makeStreamHandlers); the background subscriber acknowledges
        // them so the SSE stream stays healthy.
      },
      onWarning: (data) => {
        console.warn('[chat-stream-manager] warning:', data?.message || data);
      },
      onInfo: (data) => {
        console.info('[chat-stream-manager] info:', data?.message || data);
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
    };

  streamWorkbenchReconnect(sessionId, handlers, controller.signal, sinceSeq, {
    // Durable subscriber: effectively-unbounded retry with capped backoff.
    // The backend always emits a terminal event (done/error/aborted) when
    // the turn ends, so retries converge; a dead backend fails fast at the
    // POST /chat that started the turn. This keeps the stream bound to the
    // session across transient drops / tab switches (issue #2).
    maxRetries: Infinity,
  })
    .catch((err) => {
      if (err?.name !== 'AbortError') {
        console.warn('[chat-stream-manager] subscriber error:', err?.message || err);
      }
    })
    .finally(() => {
      // If the controller is still ours (not aborted), drop the entry so
      // a later sync can re-attach. Aborted means we intentionally stopped.
      if (!controller.signal.aborted) {
        sessionSubscribers.delete(sessionId);
      }
      // Finalize the turn we created above so isSessionStreaming reflects
      // the true state. The original stream's turn was already finalized
      // when it disconnected; this cleans up the subscriber-created turn.
      if (dummyTurnId) {
        chatRuntime.finishTurn(dummyTurnId, 'done');
      }
    });
}

export function detachSessionSubscriber(sessionId: string): void {
  const entry = sessionSubscribers.get(sessionId);
  if (!entry) return;
  entry.controller.abort();
  sessionSubscribers.delete(sessionId);
}

export function getSessionSubscriberLastSeq(sessionId: string): number {
  return sessionSubscribers.get(sessionId)?.lastSeq ?? readLastSeq(sessionId);
}

export function appendBlockEvent(
  prevBlocks: MessageBlock[],
  event: {
	    type: 'thinking' | 'text' | 'content' | 'final_output' | 'tool_call' | 'command' | 'tool_progress' | 'tool_result';
    content?: string;
    name?: string;
    id?: string;
    context?: string;
    preview?: string;
    summary?: string;
    error?: string;
    status?: 'running' | 'done' | 'error';
    duration?: number;
    isRevisedPlan?: boolean;
  }
): MessageBlock[] {
  const blocks = [...prevBlocks];
  const lastBlock = blocks[blocks.length - 1];

  if (event.type === 'thinking') {
    const text = event.content || '';
    if (lastBlock && lastBlock.type === 'thinking') {
      lastBlock.content = (lastBlock.content || '') + text;
    } else {
      blocks.push({
        id: `b_think_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'thinking',
        content: text
      });
    }
    } else if (event.type === 'text' || event.type === 'content' || event.type === 'final_output') {
    const text = event.content || '';
    if (lastBlock && lastBlock.type === 'final_output') {
      lastBlock.content = (lastBlock.content || '') + text;
    } else {
      blocks.push({
        id: `b_out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'final_output',
        content: text
      });
    }
  } else if (event.type === 'tool_call' || event.type === 'command') {
    const isCommand = event.type === 'command' || event.name?.startsWith('@run_command') || event.name?.startsWith('run_command');
    const existingIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (existingIdx !== -1) {
      const target = { ...blocks[existingIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          context: event.context || target.tool.context || '',
          status: event.status || target.tool.status || 'running',
        };
      }
      blocks[existingIdx] = target;
    } else {
      blocks.push({
        id: `b_tool_${event.id || Date.now()}`,
        type: isCommand ? 'command' : 'tool_call',
        tool: {
          id: event.id || `tc_${Date.now()}`,
          name: event.name || 'tool',
          context: event.context || '',
          status: event.status || 'running',
          startedAt: Date.now()
        },
        ...(event.isRevisedPlan ? { isRevisedPlan: true } : {}),
      });
    }
  } else if (event.type === 'tool_progress') {
    const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (targetIdx !== -1) {
      const target = { ...blocks[targetIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          preview: (target.tool.preview || '') + (event.preview || '')
        };
      }
      blocks[targetIdx] = target;
    }
  } else if (event.type === 'tool_result') {
    const targetIdx = blocks.findIndex(b => b.tool && b.tool.id === event.id);
    if (targetIdx !== -1) {
      const target = { ...blocks[targetIdx] };
      if (target.tool) {
        target.tool = {
          ...target.tool,
          status: event.status || 'done',
          summary: event.summary || '',
          error: event.error || '',
          duration: event.duration
        };
      }
      blocks[targetIdx] = target;
    }
  }

  return blocks;
}

/**
 * Apply a backend SSE event to the per-session `subagentBlocks` map. Used
 * by the per-session SSE subscriber (and by the per-turn reducer when it
 * wants to surface sub-agent events). Events that don't target a sub-agent
 * (no `jobId`) are no-ops.
 *
 * Returns `true` when the event mutated state, so callers can decide
 * whether to trigger a re-render.
 */
export function applySubagentEvent(
  sessionId: string,
  event:
    | { type: 'subagent_start'; jobId: string; agentId: string; parentToolUseId?: string; scope?: string; task?: string; depth?: number }
    | { type: 'subagent_thinking'; jobId: string; content?: string }
    | { type: 'subagent_text'; jobId: string; content?: string }
    | { type: 'subagent_tool_call'; jobId: string; id: string; name: string; input?: any; context?: string; status?: 'running' | 'done' | 'error' }
    | { type: 'subagent_tool_result'; jobId: string; id: string; content?: any; is_error?: boolean; status?: 'done' | 'error' | 'running'; summary?: string; error?: string; duration?: number }
    | { type: 'subagent_done'; jobId: string; status?: 'completed' | 'failed' | 'cancelled'; message?: string; result?: string }
): boolean {
  if (!sessionId || !event?.jobId) return false;
  const jobId = event.jobId;
  let mutated = false;

  if (event.type === 'subagent_start') {
    updateSessionStreamState(sessionId, (prev) => {
      const blocks = new Map(prev.subagentBlocks);
      if (blocks.has(jobId)) return {};
      blocks.set(jobId, {
        id: `sb_${jobId}`,
        jobId,
        parentToolId: event.parentToolUseId || `subagent-${jobId}`,
        agentId: event.agentId,
        scope: event.scope,
        task: event.task,
        depth: event.depth,
        status: 'running',
        startedAt: Date.now(),
        blocks: [],
      });
      mutated = true;
      return { subagentBlocks: blocks };
    });
    return mutated;
  }

  if (event.type === 'subagent_done') {
    updateSessionStreamState(sessionId, (prev) => {
      const blocks = new Map(prev.subagentBlocks);
      const current = blocks.get(jobId);
      if (!current) return {};
      const status = event.status === 'failed' ? 'failed'
        : event.status === 'cancelled' ? 'cancelled'
        : 'completed';
      blocks.set(jobId, {
        ...current,
        status,
        finishedAt: Date.now(),
        error: event.message,
      });
      mutated = true;
      return { subagentBlocks: blocks };
    });
    return mutated;
  }

  // For thinking/text/tool_call/tool_result events, mutate the inner
  // blocks array via appendBlockEvent (same reducer as the parent).
  updateSessionStreamState(sessionId, (prev) => {
    const blocks = new Map(prev.subagentBlocks);
    const current = blocks.get(jobId);
    if (!current) return {};
    if (event.type === 'subagent_thinking') {
      const inner = appendBlockEvent(current.blocks, { type: 'thinking', content: event.content || '' });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagent_text') {
      const inner = appendBlockEvent(current.blocks, { type: 'text', content: event.content || '' });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagent_tool_call') {
      const context = event.context
        || (event.input && Object.keys(event.input).length > 0
          ? JSON.stringify(event.input, null, 2)
          : '');
      const inner = appendBlockEvent(current.blocks, {
        type: 'tool_call',
        id: event.id,
        name: event.name,
        context,
        status: event.status || 'running',
      });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagent_tool_result') {
      const resultStr = typeof event.content === 'string'
        ? event.content
        : event.content != null ? JSON.stringify(event.content) : '';
      const inner = appendBlockEvent(current.blocks, {
        type: 'tool_result',
        id: event.id,
        status: (event.status || (event.is_error ? 'error' : 'done')) as 'done' | 'error',
        summary: event.summary || resultStr.slice(0, 240),
        error: event.error || (event.is_error ? resultStr.slice(0, 240) : ''),
        duration: event.duration,
      });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    }
    return { subagentBlocks: blocks };
  });
  return mutated;
}

// ── Resilience: re-attach SSE subscribers on tab refocus / network recovery ──
//
// A dropped per-turn stream (tab switch, throttling, brief network blip) used
// to finalize the turn as errored even though the backend kept generating.
// The durable per-session subscriber (ensureSessionSubscriber, unbounded
// retries) keeps the stream bound to the session, but it only gets re-attached
// if something calls syncActiveStreams. We trigger that here on:
//   * visibilitychange (document refocus / tab switch back)
//   * online (network recovered after going offline)
// in addition to the existing poller. This is the frontend half of issue #2:
// long tool→think cycles stay live across interruptions.

let _registeredEnsureSession: ((sessionId: string) => Promise<any>) | null = null;
let _resyncListenersAttached = false;

/** Register the ensureWorkbenchSession callback used by the auto-resync
 *  listeners, and attach the window listeners (idempotently). Called once
 *  at app init with the real session-ensure function. */
export function registerStreamResync(
  ensureWorkbenchSession: (sessionId: string) => Promise<any>,
): void {
  _registeredEnsureSession = ensureWorkbenchSession;
  if (_resyncListenersAttached || typeof window === 'undefined') return;
  _resyncListenersAttached = true;

  const resync = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // syncActiveStreams accepts a no-arg ensureWorkbenchSession; wrap ours.
    syncActiveStreams(() => _registeredEnsureSession
      ? _registeredEnsureSession('')
      : Promise.resolve(null));
  };

  window.addEventListener('visibilitychange', resync);
  window.addEventListener('online', resync);
}
