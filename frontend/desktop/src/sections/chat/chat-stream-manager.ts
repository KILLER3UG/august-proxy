import { atom } from 'nanostores';
import type { ChatMessage, MessageBlock } from './ChatThread';
import type { WorkbenchSession } from '@/types/workbench';
import { streamWorkbenchChat, streamWorkbenchReconnect, stopWorkbenchChat } from '@/api/workbench';
import { setSessionStatus, clearSessionStatus, $sessions } from '@/store/sessions';
import { makeStreamHandlers } from './makeStreamHandlers';
import { gitApi } from '@/api/git';
import { chatRuntime } from './chat-runtime';

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
  toolProgress: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  workbenchBtw: any;
  workbenchSession: WorkbenchSession | null;
}

// Global store for the stream states of all sessions
export const $sessionStreamStates = atom<Record<string, SessionStreamState>>({});

// Keep track of active fetch AbortControllers on the client
const activeStreamControllers = new Map<string, AbortController>();

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
      guardMode: 'plan',
    };
  }

  const state: SessionStreamState = {
    messages: initialMessages,
    subagentPrompts: new Map(),
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
    // Already streaming
    return;
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
    queuedMessage: null,
    setQueuedMessage: () => {},
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

    await streamWorkbenchChat({
      sessionId: session.id,
      message: params.message,
      provider: params.getWorkbenchProvider(),
      effort: params.effort,
      model: params.model,
      modelProvider: params.modelProvider,
    }, handlers, abortController.signal);

    finalize(abortController.signal.aborted ? 'aborted' : 'done');
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      clearSessionStatus(sessionId);
      finalize('aborted');
      return;
    }
    console.error(e);
    updateSessionStreamState(sessionId, prev => ({
      messages: prev.messages.map(msg =>
        msg.id === assistantMsgId ? { ...msg, content: (msg.content || '') + `\n\n⚠️ Connection error: ${e.message}` } : msg
      )
    }));
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
    await stopWorkbenchChat(sessionId);
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
    queuedMessage: null,
    setQueuedMessage: () => {},
    gitApi,
    streamUpdateIntervalMs: 24,
    appendBlockEvent,
  });

  try {
    chatRuntime.setTransport(turn.turnId, 'http');

    await streamWorkbenchReconnect(sessionId, handlers, abortController.signal);
    finalize(abortController.signal.aborted ? 'aborted' : 'done');
  } catch (e: any) {
    if (e?.name === 'AbortError') {
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
    const res = await fetch('/ui/workbench/chat/active');
    if (!res.ok) return;
    const active: Record<string, string> = await res.json();
    for (const [sessionId, status] of Object.entries(active)) {
      if (status === 'streaming') {
        reconnectChatStream(sessionId, ensureWorkbenchSession);
      }
    }
  } catch (err) {
    console.warn('Failed to sync active streams:', err);
  }
}

export function appendBlockEvent(
  prevBlocks: MessageBlock[],
  event: {
    type: 'thinking' | 'text' | 'content' | 'tool_call' | 'command' | 'tool_progress' | 'tool_result';
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
  } else if (event.type === 'text' || event.type === 'content') {
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
