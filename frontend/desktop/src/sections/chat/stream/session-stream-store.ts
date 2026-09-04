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
import { useSessionsStore, isSessionIdTombstoned } from '@/store/sessions';
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

/** Max number of session transcripts kept in memory. Streams are heavy
 *  (tool previews can be tens of KB per session) and a long-lived desktop
 *  app must not accumulate every session ever opened. */
const MAX_CACHED_SESSIONS = 12;
const _accessOrder: string[] = [];

function _touchSession(sessionId: string): void {
  const idx = _accessOrder.indexOf(sessionId);
  if (idx !== -1) _accessOrder.splice(idx, 1);
  _accessOrder.push(sessionId);
}

/** Drop the least-recently-touched transcripts beyond the cache cap. */
function _evictIfNeeded(): void {
  const bySession = useSessionStreamStore.getState().bySession;
  const keys = Object.keys(bySession);
  if (keys.length <= MAX_CACHED_SESSIONS) return;
  const excess = keys.length - MAX_CACHED_SESSIONS;
  const toEvict = new Set<string>();
  for (const k of _accessOrder) {
    if (toEvict.size >= excess) break;
    if (bySession[k]) toEvict.add(k);
  }
  if (toEvict.size < excess) {
    for (const k of keys) {
      if (toEvict.size >= excess) break;
      if (!toEvict.has(k)) toEvict.add(k);
    }
  }
  if (toEvict.size === 0) return;
  const next = { ...bySession };
  for (const k of toEvict) delete next[k];
  useSessionStreamStore.setState({ bySession: next });
  for (const k of toEvict) {
    const i = _accessOrder.indexOf(k);
    if (i !== -1) _accessOrder.splice(i, 1);
  }
}

/** Drop one session's in-memory transcript (session deleted / cleared). */
export function evictSessionStreamState(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const bySession = useSessionStreamStore.getState().bySession;
  if (!bySession[sessionId]) return;
  const next = { ...bySession };
  delete next[sessionId];
  useSessionStreamStore.setState({ bySession: next });
  const i = _accessOrder.indexOf(sessionId);
  if (i !== -1) _accessOrder.splice(i, 1);
}

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

/** Stream-local message hydrate. Empty array when nothing is stored. */
export function loadMessagesForSession(sessionId: string | null): ChatMessage[] {
  return loadMessagesFromStorage(sessionId);
}

export function persistMessages(sessionId: string, messages: ChatMessage[]): void {
  // A deleted session's handlers must never write a resurrected transcript.
  if (isSessionIdTombstoned(sessionId)) return;
  persistMessagesToStorage(sessionId, messages);
}

/** Debounced persistence for active streaming — writes at most once per 1000ms.
 *  Call `flushPersistMessages` on stream finalization for a guaranteed save. */
const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _persistPending = new Map<string, ChatMessage[]>();
const _PERSIST_DEBOUNCE_MS = 1000;

export function persistMessagesDebounced(sessionId: string, messages: ChatMessage[]): void {
  // A deleted session's handlers must never write a resurrected transcript.
  if (isSessionIdTombstoned(sessionId)) return;
  _persistPending.set(sessionId, messages);
  if (_persistTimers.has(sessionId)) return; // already scheduled
  _persistTimers.set(
    sessionId,
    setTimeout(() => {
      _persistTimers.delete(sessionId);
      const pending = _persistPending.get(sessionId);
      if (pending) {
        _persistPending.delete(sessionId);
        persistMessagesToStorage(sessionId, pending);
      }
    }, _PERSIST_DEBOUNCE_MS),
  );
}

/** Immediately flush any pending debounced persist (call on stream end). */
export function flushPersistMessages(sessionId: string): void {
  if (isSessionIdTombstoned(sessionId)) {
    // Session was deleted mid-turn — drop the pending write instead of
    // resurrecting the transcript.
    _persistTimers.delete(sessionId);
    _persistPending.delete(sessionId);
    return;
  }
  const timer = _persistTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    _persistTimers.delete(sessionId);
  }
  const pending = _persistPending.get(sessionId);
  if (pending) {
    _persistPending.delete(sessionId);
    persistMessagesToStorage(sessionId, pending);
  }
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
  // A deleted session (tombstoned) must not be resurrected in memory — the
  // aborting turn's handlers would otherwise re-create state and keep
  // writing. Return a throwaway empty state without touching the store.
  if (isSessionIdTombstoned(sessionId)) {
    return emptyStreamState();
  }

  _touchSession(sessionId);
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
  _evictIfNeeded();

  return state;
}

/**
 * Non-mutating read for RENDER paths. Unlike getOrInitSessionStreamState this
 * never writes the store, touches the LRU order, or evicts — so it is safe to
 * call from a component's render body. getOrInit calls useSessionStreamStore.
 * setState on first init, which React rejects as "Cannot update a component
 * while rendering a different component" when a render-phase caller (e.g.
 * ArenaView reading its lanes' transcripts) hits a not-yet-initialized or
 * evicted session. Returns the live state if present, else a throwaway empty
 * state (the caller only reads it; the stream's own handlers init on write).
 */
export function peekSessionStreamState(sessionId: string | null): SessionStreamState {
  if (!sessionId) return emptyStreamState();
  return useSessionStreamStore.getState().bySession[sessionId] ?? emptyStreamState();
}

export function updateSessionStreamState(
  sessionId: string,
  updater: (prev: SessionStreamState) => Partial<SessionStreamState>
) {
  // A deleted session's handlers must never write (transcript resurrection).
  if (isSessionIdTombstoned(sessionId)) return;
  const current = getOrInitSessionStreamState(sessionId);
  const next = { ...current, ...updater(current) };
  useSessionStreamStore.setState({
    bySession: {
      ...useSessionStreamStore.getState().bySession,
      [sessionId]: next,
    },
  });
}
