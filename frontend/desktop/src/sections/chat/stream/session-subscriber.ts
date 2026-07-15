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
  try { localStorage.setItem(SUB_LAST_SEQ(sessionId), String(seq)); } catch { /* silent */ }
}

/**
 * Attach (or re-attach) the per-session SSE subscriber that pulls events
 * from GET /api/workbench/chat/stream. Idempotent: if one is already
 * attached for `sessionId` it is left alone. The reducer updates
 * `subagentBlocks` and bumps stored `lastSeq` so reconnects don't replay.
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
  //
  // Keep the dummy turn alive for the whole reconnect life-cycle — only
  // finish it when the subscriber truly ends (terminal event / abort).
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

  const subagentHandlers = makeSubagentEventHandlers(sessionId);

  const handlers: WorkbenchEventHandlers = {
    onSeq: (seq) => {
      if (seq > entry.lastSeq) {
        entry.lastSeq = seq;
        writeLastSeq(sessionId, seq);
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
      // A follow-up was queued (possibly from another tab or via the
      // optimistic local API call). Add it to the per-session queue
      // store so the UI pills update in real time.
      if (!data?.messageId || !data?.sessionId) return;
      upsertQueuedMessage(data.sessionId, {
        id: data.messageId,
        text: data.text ?? '',
        queuedAt: data.queuedAt ?? new Date().toISOString(),
      });
    },
    onUserMessageDequeued: (data) => {
      if (!data?.messageId || !data?.sessionId) return;
      removeQueuedMessage(data.sessionId, data.messageId);
    },
    onUserMessageInjected: (data) => {
      // The backend drained this message and appended it to the model's
      // in-flight conversation. Clear it from the local queue (it now
      // lives as an inline user bubble in the chat thread) and append
      // a synthetic user message to the session's message log so the
      // thread renders it in the right place.
      if (!data?.messageId || !data?.sessionId) return;
      removeQueuedMessage(data.sessionId, data.messageId);
      const entry = {
        id: `qm-${data.messageId}`,
        role: 'user' as const,
        content: data.text ?? '',
        timestamp: data.queuedAt ?? new Date().toISOString(),
        queued: true,
      };
      updateSessionStreamState(data.sessionId, (prev) => ({
        ...prev,
        messages: [...(prev.messages ?? []), entry],
      }));
    },
    onClarifyProposed: (data) => {
      // Attach the clarifying question to the last assistant message so the
      // ClarifyTool popup renders even when the event arrives on the
      // background subscriber (e.g. after a reconnect mid-turn).
      updateSessionStreamState(sessionId, (prev) => {
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

// Sync all active streams with the backend
export async function syncActiveStreams(_ensureWorkbenchSession: () => Promise<WorkbenchSession | null>) {
  try {
    const active = await api.get<Record<string, string>>('/api/workbench/chat/active');
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
    // syncActiveStreams accepts a no-arg ensureWorkbenchSession; wrap ours.
    void syncActiveStreams(() => _registeredEnsureSession
      ? _registeredEnsureSession('')
      : Promise.resolve(null));
  };

  window.addEventListener('visibilitychange', resync);
  window.addEventListener('online', resync);
}
