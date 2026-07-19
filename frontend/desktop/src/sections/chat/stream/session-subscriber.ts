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
import { api } from '@/api/client';
import { streamWorkbenchReconnect } from '@/api/workbench';
import { chatRuntime } from '../chat-runtime';
import { pushBrowserAction } from '@/lib/browser-store';
import { upsertQueuedMessage, removeQueuedMessage } from '../queue-store';
import { updateSessionStreamState } from './session-stream-store';
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

  // Ensure there is an active turn in chatRuntime so the AUG streaming
  // indicator (WorkingIndicator) shows while the backend is generating.
  // Key the turn by UI session id so ChatThread's sess_* checks work.
  let dummyTurnId: string | null = null;
  if (!chatRuntime.isSessionStreaming(uiSessionId)) {
    const assistantMsgId = `subscriber-${uiSessionId}-${Date.now()}`;
    const turn = chatRuntime.startTurn({
      sessionId: uiSessionId,
      assistantMsgId,
      transport: 'none',
    });
    dummyTurnId = turn.turnId;
  }

  const controller = new AbortController();
  const sinceSeq = readLastSeq(wbId);
  const entry = { controller, lastSeq: sinceSeq, uiSessionId };
  sessionSubscribers.set(wbId, entry);

  const subagentHandlers = makeSubagentEventHandlers(uiSessionId);

  const handlers: WorkbenchEventHandlers = {
    onSeq: (seq) => {
      if (seq > entry.lastSeq) {
        entry.lastSeq = seq;
        writeLastSeq(wbId, seq);
      }
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
      }
      if (dummyTurnId) {
        chatRuntime.finishTurn(dummyTurnId, 'done');
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

// Sync all active streams with the backend
export async function syncActiveStreams(_ensureWorkbenchSession: () => Promise<WorkbenchSession | null>) {
  try {
    const active = await api.get<Record<string, string>>('/api/workbench/chat/active');
    for (const wbId of Object.keys(active)) {
      if (active[wbId] === 'streaming') {
        // Only attach durable SSE when no per-turn consumer owns this session.
        ensureSessionSubscriber(wbId);
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
