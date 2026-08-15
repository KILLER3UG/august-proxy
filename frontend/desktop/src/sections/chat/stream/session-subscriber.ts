/**
 * Durable per-session SSE subscriber for GET /api/workbench/chat/stream.
 *
 * Independent of the per-turn AbortController: detaching (session switch)
 * closes only the client connection — backend generation continues. Other
 * clients re-attach via sinceSeq and replay from the chat-event-log.
 *
 * lastSeq is persisted in localStorage so reconnects after reload skip
 * already-applied events. Sub-agent, queue, clarify, and browser-action
 * events are applied here so background agents stay visible without an
 * active per-turn handler.
 *
 * registerStreamResync re-attaches subscribers on tab refocus / online so
 * long tool→think cycles survive brief disconnects.
 *
 * Stream store / chatRuntime keys use the UI `sess_*` id; SSE is keyed by
 * workbench `wb_*` id so concurrent chats never cross-wire state.
 */

import type { WorkbenchSession } from '@/types/workbench';
import type { WorkbenchEventHandlers } from '@/types/workbench';
import { toast } from 'sonner';
import { pushNotification } from '@/store/notifications';
import { api } from '@/api/client';
import { streamWorkbenchReconnect } from '@/api/workbench';
import { pushBrowserAction } from '@/lib/browser-store';
import { upsertQueuedMessage, removeQueuedMessage } from '../queue-store';
import { updateSessionStreamState, useSessionStreamStore } from './session-stream-store';
import { makeSubagentEventHandlers } from './apply-subagent-event';
import { activeStreamControllers } from './active-stream-controllers';
import {
  resolveUiSessionId,
  resolveWorkbenchSessionId,
} from './session-id-map';

/** Subscribers keyed by workbench session id (backend SSE key). */
const sessionSubscribers = new Map<string, {
  controller: AbortController;
  lastSeq: number;
  uiSessionId: string;
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
  try { localStorage.setItem(SUB_LAST_SEQ(sessionId), String(seq)); } catch { /* silent */ }
}

/** True when a durable SSE subscriber is already open for this workbench id. */
export function hasSessionSubscriber(sessionOrWorkbenchId: string): boolean {
  const wbId = resolveWorkbenchSessionId(sessionOrWorkbenchId);
  return sessionSubscribers.has(wbId);
}

/**
 * Attach (or re-attach) the per-session SSE subscriber that pulls events
 * from GET /api/workbench/chat/stream. Idempotent: if one is already
 * attached for the workbench id, or a per-turn stream owns the connection,
 * it is left alone.
 */
export function ensureSessionSubscriber(sessionOrWorkbenchId: string): void {
  if (!sessionOrWorkbenchId) return;

  const wbId = resolveWorkbenchSessionId(sessionOrWorkbenchId);
  const uiSessionId = resolveUiSessionId(sessionOrWorkbenchId);

  if (sessionSubscribers.has(wbId)) return;
  // Per-turn startChatStream owns the SSE — avoid a second connection.
  if (activeStreamControllers.has(uiSessionId)) return;

  // NOTE: no dummy chatRuntime turn here. This subscriber attaches while the
  // session is IDLE, so a fabricated 'streaming' turn would make a fresh
  // session show the Stop button and the working indicator forever (the
  // subscriber stays connected on keepalives). Streaming state comes from
  // real per-turn turns (poller-driven reconnect) and the backend
  // /chat/active map.

  const controller = new AbortController();
  const sinceSeq = readLastSeq(wbId);
  const entry = { controller, lastSeq: sinceSeq, uiSessionId };
  sessionSubscribers.set(wbId, entry);

  const subagentHandlers = makeSubagentEventHandlers(uiSessionId);

  // Events this subscriber actually renders. Turn-content events (text,
  // thinking, toolUse, …) are NOT here: if this subscriber were attached
  // while a turn is running (e.g. a backend auto-turn before the 15s poll
  // notices it), advancing lastSeq past those events would make the
  // per-turn reconnect skip them and the reply would never render. Instead
  // the per-turn consumer replays them from the persisted position.
  const RENDERED_EVENT_TYPES = new Set([
    'subagentStart',
    'subagentDone',
    'subagentText',
    'subagentToolCall',
    'subagentToolResult',
    'subagentRetry',
    'browserAction',
    'userMessageQueued',
    'userMessageDequeued',
    'userMessageInjected',
    'clarifyProposed',
    'warning',
    'info',
    'compaction',
  ]);

  const handlers: WorkbenchEventHandlers = {
    onSeq: (seq, eventType) => {
      if (seq > entry.lastSeq && (!eventType || RENDERED_EVENT_TYPES.has(eventType))) {
        entry.lastSeq = seq;
        writeLastSeq(wbId, seq);
      }
    },
    onStarted: () => {
      // A turn is now running — the per-turn consumer (startChatStream or
      // the poller-driven reconnect) owns the stream from here. Detach so
      // this subscriber never consumes turn events it doesn't render.
      detachSessionSubscriber(wbId);
    },
    onDone: () => {
      // Turn ended while we were attached (attached after `started` was
      // missed). Nothing further to render — detach; the next attachment
      // resumes from the persisted position.
      detachSessionSubscriber(wbId);
    },
    ...subagentHandlers,
    onCompaction: (_data) => {
      // Compaction events are handled by the per-turn handler
      // (makeStreamHandlers); the background subscriber acknowledges
      // them so the SSE stream stays healthy.
    },
    onWarning: (data) => {
      console.warn('[chat-stream-manager] warning:', data?.message || data);
    },
    onInfo: (data) => {
      const kind = (data?.extras as { kind?: string } | undefined)?.kind;
      if (kind === 'harnessAutoContinue' || kind === 'harnessLaneDone') {
        const title = kind === 'harnessAutoContinue' ? 'Lane continuing' : 'Lane done';
        if (data.message) toast.message(data.message);
        pushNotification(title, data.message, 'info');
        if (typeof document !== 'undefined' && document.hidden && typeof Notification !== 'undefined') {
          if (Notification.permission === 'granted') {
            try {
              new Notification(title, { body: data.message || '' });
            } catch {
              /* ignore */
            }
          } else if (Notification.permission === 'default') {
            void Notification.requestPermission();
          }
        }
        return;
      }
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
    onUserMessageQueued: (data) => {
      if (!data?.messageId || !data?.sessionId) return;
      const queueUiId = resolveUiSessionId(data.sessionId);
      upsertQueuedMessage(queueUiId, {
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
      if (!data?.messageId || !data?.sessionId) return;
      const queueUiId = resolveUiSessionId(data.sessionId);
      removeQueuedMessage(queueUiId, data.messageId);
      const injected = {
        id: `qm-${data.messageId}`,
        role: 'user' as const,
        content: data.text ?? '',
        timestamp: data.queuedAt ?? new Date().toISOString(),
        queued: true,
      };
      updateSessionStreamState(queueUiId, (prev) => ({
        ...prev,
        messages: [...(prev.messages ?? []), injected],
      }));
    },
    onClarifyProposed: (data) => {
      updateSessionStreamState(uiSessionId, (prev) => {
        const msgs = prev.messages ?? [];
        if (msgs.length === 0) return prev;
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            lastAssistantIdx = i;
            break;
          }
        }
        if (lastAssistantIdx === -1) return prev;
        return {
          ...prev,
          messages: msgs.map((m, i) => (i === lastAssistantIdx ? { ...m, clarify: data } : m)),
        };
      });
    },
  };

  streamWorkbenchReconnect(wbId, handlers, controller.signal, sinceSeq, {
    // Durable subscriber: effectively-unbounded retry with capped backoff.
    maxRetries: Infinity,
  })
    .catch((err) => {
      if (err?.name !== 'AbortError') {
        console.warn('[chat-stream-manager] subscriber error:', err?.message || err);
      }
    })
    .finally(() => {
      if (!controller.signal.aborted) {
        sessionSubscribers.delete(wbId);
        // Background subagents often settle after the turn's `done`, when
        // this subscriber has already closed. If any containers are still
        // running, re-attach so their late subagentDone events (already in
        // the backend event log) still reach the chat UI. The backend tail
        // only breaks on done|error|aborted, so the fresh stream idles
        // until the completions arrive.
        const state = useSessionStreamStore.getState().bySession[uiSessionId];
        const hasRunningSubagents = state
          ? Array.from(state.subagentBlocks.values()).some((b) => b.status === 'running')
          : false;
        if (hasRunningSubagents) {
          ensureSessionSubscriber(wbId);
        }
      }
    });
}

export function detachSessionSubscriber(sessionOrWorkbenchId: string): void {
  const wbId = resolveWorkbenchSessionId(sessionOrWorkbenchId);
  const entry = sessionSubscribers.get(wbId);
  if (!entry) return;
  entry.controller.abort();
  sessionSubscribers.delete(wbId);
}

export function getSessionSubscriberLastSeq(sessionOrWorkbenchId: string): number {
  const wbId = resolveWorkbenchSessionId(sessionOrWorkbenchId);
  return sessionSubscribers.get(wbId)?.lastSeq ?? readLastSeq(wbId);
}

/** Advance the persisted lastSeq (and a live subscriber entry, if any). */
export function advanceSessionSubscriberLastSeq(sessionOrWorkbenchId: string, seq: number): void {
  if (!Number.isFinite(seq) || seq <= 0) return;
  const wbId = resolveWorkbenchSessionId(sessionOrWorkbenchId);
  const entry = sessionSubscribers.get(wbId);
  if (entry) {
    if (seq > entry.lastSeq) entry.lastSeq = seq;
    writeLastSeq(wbId, seq);
  } else {
    writeLastSeq(wbId, seq);
  }
}

// Sync all active streams with the backend
export async function syncActiveStreams(ensureWorkbenchSession: () => Promise<WorkbenchSession | null>) {
  try {
    const active = await api.get<Record<string, string>>('/api/workbench/chat/active');
    // Lazy import avoids a static cycle (start-stop-stream imports this module).
    const { reconnectChatStream } = await import('./start-stop-stream');
    for (const wbId of Object.keys(active)) {
      if (active[wbId] === 'streaming') {
        // Reconnect with FULL per-turn handlers (text / toolUse / done) so a
        // reply truncated by a reload mid-stream actually completes. The
        // durable subscriber alone drops main-turn events and leaves the
        // assistant bubble stuck at its persisted prefix forever.
        void reconnectChatStream(wbId, ensureWorkbenchSession);
      }
    }
  } catch (err) {
    console.warn('Failed to sync active streams:', err);
  }
}

let _registeredEnsureSession: ((sessionId: string) => Promise<WorkbenchSession | null>) | null = null;
let _resyncListenersAttached = false;

/** Register the ensureWorkbenchSession callback used by the auto-resync
 *  listeners, and attach the window listeners (idempotently). Called once
 *  at app init with the real session-ensure function. */
export function registerStreamResync(
  ensureWorkbenchSession: (sessionId: string) => Promise<WorkbenchSession | null>,
): void {
  _registeredEnsureSession = ensureWorkbenchSession;
  if (_resyncListenersAttached || typeof window === 'undefined') return;
  _resyncListenersAttached = true;

  const resync = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void syncActiveStreams(() => _registeredEnsureSession
      ? _registeredEnsureSession('')
      : Promise.resolve(null));
  };

  window.addEventListener('visibilitychange', resync);
  window.addEventListener('online', resync);
}
