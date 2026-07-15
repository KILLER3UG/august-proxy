/**
 * Per-session stream store — live messages, nested sub-agent containers,
 * tool progress, and workbench session snapshot for every open chat.
 *
 * Written by turn handlers (makeStreamHandlers) and the durable SSE
 * subscriber. Read by ChatThread via $sessionStreamStates / useSessionStream.
 * Messages hydrate from localStorage on first touch so a refresh restores
 * the transcript without waiting for a backend round-trip.
 */

import { create } from 'zustand';
import type { ChatMessage } from '@/types/chat';
import type { WorkbenchSession } from '@/types/workbench';
import { useSessionsStore } from '@/store/sessions';
import {
  loadMessagesForSession as loadMessagesFromStorage,
  persistMessages as persistMessagesToStorage,
} from '../message-storage';

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
   *  holds its own `blocks` array so thinking/text/toolCall/toolResult
   *  events for the sub-agent are rendered nested under the parent
   *  `august__spawn_subagent` / `august__run_team` tool call. */
  subagentBlocks: Map<string, SubagentBlockState>;
  toolProgress: Map<string, ReadonlyArray<ToolProgressEntry>>;
  workbenchBtw: WorkbenchBtwState | null;
  workbenchSession: WorkbenchSession | null;
}

export type {
  ChatMessage,
  MessageBlock,
  SubagentBlockState,
  ToolProgressEntry,
  WorkbenchBtwState,
} from '@/types/chat';
import type { SubagentBlockState, ToolProgressEntry, WorkbenchBtwState } from '@/types/chat';

/** Apply a React-style SetStateAction updater to a previous value. Mirrors
 *  the semantics of `React.Dispatch<React.SetStateAction<T>>` so the chat
 *  store layer can use the same calling convention. */
export function applyUpdater<T>(updater: T | ((prev: T) => T), prev: T): T {
  return typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;
}

interface SessionStreamStoreState {
  bySession: Record<string, SessionStreamState>;
}

export const useSessionStreamStore = create<SessionStreamStoreState>(() => ({
  bySession: {},
}));

/** Nanostores-shaped shim for imperative get/set/subscribe callers. */
export const $sessionStreamStates = {
  get: (): Record<string, SessionStreamState> => useSessionStreamStore.getState().bySession,
  set: (bySession: Record<string, SessionStreamState>): void => {
    useSessionStreamStore.setState({ bySession });
  },
  subscribe: (listener: (bySession: Record<string, SessionStreamState>) => void): (() => void) => {
    listener(useSessionStreamStore.getState().bySession);
    return useSessionStreamStore.subscribe((s) => listener(s.bySession));
  },
};

/** Stream-local message hydrate (no demo-thread fallback). Empty array when
 *  nothing is stored — ChatThread supplies demos on its own load path. */
export function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  return loadMessagesFromStorage(sessionId, () => []);
}

export function persistMessages(sessionId: string, messages: ChatMessage[]): void {
  persistMessagesToStorage(sessionId, messages);
}

function emptyStreamState(workbenchSession: WorkbenchSession | null = null): SessionStreamState {
  return {
    messages: [],
    subagentPrompts: new Map(),
    subagentBlocks: new Map(),
    toolProgress: new Map(),
    workbenchBtw: null,
    workbenchSession,
  };
}

export function getOrInitSessionStreamState(sessionId: string | null): SessionStreamState {
  if (!sessionId) {
    return emptyStreamState();
  }

  const current = useSessionStreamStore.getState().bySession[sessionId];
  if (current) return current;

  // Initialize from localStorage or defaults
  const initialMessages = loadMessagesForSession(sessionId);

  let workbenchSession: WorkbenchSession | null = null;
  const sessions = useSessionsStore.getState().sessions;
  const activeSession = sessions.find(s => s.id === sessionId);
  if (activeSession?.workbenchSessionId) {
    workbenchSession = {
      id: activeSession.workbenchSessionId,
      provider: (activeSession.workbenchProvider || ''),
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

  useSessionStreamStore.setState({
    bySession: {
      ...useSessionStreamStore.getState().bySession,
      [sessionId]: state,
    },
  });

  return state;
}

export function updateSessionStreamState(
  sessionId: string,
  updater: (prev: SessionStreamState) => Partial<SessionStreamState>
) {
  const current = getOrInitSessionStreamState(sessionId);
  const next = { ...current, ...updater(current) };
  useSessionStreamStore.setState({
    bySession: {
      ...useSessionStreamStore.getState().bySession,
      [sessionId]: next,
    },
  });
}
