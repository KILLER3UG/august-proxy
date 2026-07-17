/**
 * Global realtime bridge — one EventSource for all backend→frontend push.
 *
 * Backend: GET /api/realtime/stream
 * Events are applied immediately to Zustand + React Query so the UI never
 * waits on multi-second pollers for state that already changed server-side.
 */

import { queryClient } from '@/query-client';
import {
  removeSessionLocally,
  useSessionsStore,
  saveSessionsToStorage,
  setSessionStatus,
  clearSessionStatus,
  preferSessionTitle,
  isPlaceholderTitle,
  sessionIsEmpty,
  dedupeSessions,
  type Session,
  type SessionStatus,
} from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';

export type RealtimeEvent = {
  id?: string;
  type: string;
  at?: number;
  sessionId?: string;
  status?: string;
  title?: string;
  provider?: string;
  model?: string;
  agentId?: string;
  guardMode?: string;
  messageCount?: number;
  plan?: boolean;
  planApproved?: boolean;
  pendingMutations?: boolean;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  workspacePath?: string;
  queryKeys?: string[];
  [key: string]: unknown;
};

let es: EventSource | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function upsertSessionFromEvent(ev: RealtimeEvent): void {
  const sid = String(ev.sessionId || '');
  if (!sid) return;
  const sessions = useSessionsStore.getState().sessions;
  let idx = sessions.findIndex(
    (s) => s.id === sid || s.workbenchSessionId === sid,
  );

  // Race: workbench `session.created` often arrives before ChatThread has
  // written workbenchSessionId onto the open local `sess_*` row. Prefer
  // linking a single empty local draft instead of inserting a duplicate.
  if (idx < 0) {
    const pendingIndexes = sessions
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          !s.isArchived &&
          !s.workbenchSessionId &&
          sessionIsEmpty(s) &&
          s.id.startsWith('sess_'),
      );
    if (pendingIndexes.length === 1) {
      idx = pendingIndexes[0].i;
    } else if (pendingIndexes.length > 1) {
      // Most recently started empty draft
      pendingIndexes.sort(
        (a, b) =>
          new Date(b.s.startedAt).getTime() - new Date(a.s.startedAt).getTime(),
      );
      idx = pendingIndexes[0].i;
    }
  }

  if (idx >= 0) {
    const prev = sessions[idx];
    const incomingTitle = ev.title;
    // Prefer a real incoming title; never replace a good title with a placeholder.
    const nextTitle =
      incomingTitle && !isPlaceholderTitle(incomingTitle)
        ? incomingTitle
        : preferSessionTitle(prev.title, incomingTitle);
    const next: Session = {
      ...prev,
      // Keep stable UI id — never rewrite sess_* → wb_* here.
      id: prev.id,
      title: nextTitle,
      provider: (ev.provider) || prev.provider,
      model: (ev.model) || prev.model,
      messageCount:
        typeof ev.messageCount === 'number' ? ev.messageCount : prev.messageCount,
      workbenchSessionId: prev.workbenchSessionId || sid,
      workbenchProvider: (ev.provider) || prev.workbenchProvider,
      workbenchAgentId: (ev.agentId) || prev.workbenchAgentId,
    };
    const updated = sessions.slice();
    updated[idx] = next;
    const deduped = dedupeSessions(updated);
    useSessionsStore.setState({ sessions: deduped });
    saveSessionsToStorage(deduped);
    return;
  }
  // New session from tool / other tab (no local draft to attach)
  const created: Session = {
    id: sid,
    title: (ev.title) || 'New Session',
    startedAt: (ev.startedAt) || (ev.createdAt) || new Date().toISOString(),
    messageCount: typeof ev.messageCount === 'number' ? ev.messageCount : 0,
    lastMessage: 'Conversation started.',
    provider: (ev.provider) || '',
    model: (ev.model) || '',
    workbenchSessionId: sid,
    workbenchProvider: (ev.provider) || '',
    workbenchAgentId: (ev.agentId) || '',
    workspacePath: (ev.workspacePath) || null,
    isArchived: false,
  };
  const updated = dedupeSessions([created, ...sessions]);
  useSessionsStore.setState({ sessions: updated });
  saveSessionsToStorage(updated);
}

function applySessionStatus(ev: RealtimeEvent): void {
  const sid = String(ev.sessionId || '');
  if (!sid) return;
  const status = String(ev.status || 'idle');
  // Map workbench status → sidebar SessionStatus
  const map: Record<string, SessionStatus> = {
    idle: 'idle',
    streaming: 'streaming',
    working: 'working',
    running: 'working',
    awaiting: 'awaiting',
    'awaiting_approval': 'awaiting',
    error: 'error',
    failed: 'error',
    done: 'done',
    completed: 'done',
  };
  const mapped = map[status] || (status as SessionStatus);
  if (mapped === 'idle' || mapped === 'done') {
    clearSessionStatus(sid);
  } else {
    setSessionStatus(sid, mapped);
  }
  upsertSessionFromEvent(ev);
}

function applyInvalidate(ev: RealtimeEvent): void {
  const keys = Array.isArray(ev.queryKeys) ? ev.queryKeys : [];
  const sessionId = ev.sessionId ? String(ev.sessionId) : '';
  for (const key of keys) {
    if (!key) continue;
    // Prefer precise keys when session-scoped
    if (sessionId && (key === 'workbench-session' || key === 'session-status')) {
      void queryClient.invalidateQueries({ queryKey: [key, sessionId] });
      void queryClient.invalidateQueries({ queryKey: [key] });
      continue;
    }
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

function applyChatActive(ev: RealtimeEvent, active: boolean): void {
  const sid = String(ev.sessionId || '');
  if (!sid) return;
  const prev = useActiveChatStreamsStore.getState().active;
  if (active) {
    if (prev[sid] === 'streaming') return;
    useActiveChatStreamsStore.setState({ active: { ...prev, [sid]: 'streaming' } });
    setSessionStatus(sid, 'streaming');
  } else {
    if (!prev[sid]) return;
    const next = { ...prev };
    delete next[sid];
    useActiveChatStreamsStore.setState({ active: next });
    clearSessionStatus(sid);
  }
}

function handleEvent(ev: RealtimeEvent): void {
  switch (ev.type) {
    case 'session.deleted':
      if (ev.sessionId) removeSessionLocally(String(ev.sessionId));
      break;
    case 'session.created':
    case 'session.updated':
      upsertSessionFromEvent(ev);
      if (ev.sessionId) {
        void queryClient.invalidateQueries({
          queryKey: ['workbench-session', String(ev.sessionId)],
        });
      }
      break;
    case 'session.status':
      applySessionStatus(ev);
      if (ev.sessionId) {
        void queryClient.invalidateQueries({
          queryKey: ['session-status', String(ev.sessionId)],
        });
        void queryClient.invalidateQueries({
          queryKey: ['workbench-session', String(ev.sessionId)],
        });
      }
      break;
    case 'chat.active':
      applyChatActive(ev, true);
      break;
    case 'chat.idle':
      applyChatActive(ev, false);
      break;
    case 'invalidate':
      applyInvalidate(ev);
      break;
    case 'keepalive':
      break;
    default:
      // Forward-compatible: if payload carries queryKeys, invalidate them.
      if (Array.isArray(ev.queryKeys) && ev.queryKeys.length) {
        applyInvalidate(ev);
      }
      break;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    started = false;
    startRealtimeBridge();
  }, 1500);
}

/** Open (or re-open) the global realtime SSE stream. Idempotent. */
export function startRealtimeBridge(): void {
  if (typeof window === 'undefined') return;
  if (started && es && es.readyState !== EventSource.CLOSED) return;
  started = true;
  try {
    es?.close();
  } catch {
    /* ignore */
  }
  es = new EventSource('/api/realtime/stream');
  es.onmessage = (msg: MessageEvent) => {
    try {
      const data = JSON.parse(String(msg.data)) as RealtimeEvent;
      if (data && typeof data.type === 'string') handleEvent(data);
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = () => {
    try {
      es?.close();
    } catch {
      /* ignore */
    }
    es = null;
    started = false;
    scheduleReconnect();
  };
}

export function stopRealtimeBridge(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    es?.close();
  } catch {
    /* ignore */
  }
  es = null;
  started = false;
}
