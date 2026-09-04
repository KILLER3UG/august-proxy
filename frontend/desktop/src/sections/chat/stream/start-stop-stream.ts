/**
 * Start / stop / reconnect controllers for a single chat generation turn.
 *
 * startChatStream: POST workbench chat, then attach live SSE (or consume
 * the POST body when events arrive inline). Owns the per-turn AbortController
 * in activeStreamControllers and a chatRuntime turn record.
 *
 * stopChatStream: aborts the local controller, finishes the runtime turn,
 * and tells the backend to stop generation.
 *
 * reconnectChatStream: re-opens the SSE channel for an in-progress backend
 * turn (e.g. after a client drop) using the subscriber lastSeq when known.
 */

import type { ChatMessage } from '@/types/chat';
import type { WorkbenchMode, EffortLevel } from '@/types/chat';
import type { WorkbenchSession } from '@/types/workbench';
import {
  streamWorkbenchChat,
  streamWorkbenchReconnect,
  workbenchClient,
} from '@/api/workbench';
import { setSessionStatus, clearSessionStatus } from '@/store/sessions';
import { clearActiveChatStream } from '@/store/chat-active-streams';
import { chatRuntime } from '../chat-runtime';
import {
  getOrInitSessionStreamState,
  updateSessionStreamState,
} from './session-stream-store';
import { activeStreamControllers } from './active-stream-controllers';
import { bindTurnStreamHandlers } from './bind-turn-handlers';
import {
  advanceSessionSubscriberLastSeq,
  detachSessionSubscriber,
  getSessionSubscriberLastSeq,
  hasSessionSubscriber,
} from './session-subscriber';
import { resolveWorkbenchSessionId, resolveUiSessionId } from './session-id-map';
import { takeHandoffSummary } from '../handoff-summary';

// Start a new chat generation
export async function startChatStream(
  sessionId: string,
  params: {
    message: string;
    chatHistory: ChatMessage[];
    workbenchMode: WorkbenchMode;
    effort: EffortLevel;
    /** When false, skip extended thinking / reasoning for this turn. */
    thinkingEnabled?: boolean;
    model: string | undefined;
    modelProvider: string | undefined;
    provider?: string;
    agentId?: string;
    guardMode?: string;
    /** Optional handoff brief when switching models after an interrupted turn. */
    handoffSummary?: string;
    ensureWorkbenchSession: () => Promise<WorkbenchSession | null>;
  }
): Promise<'started' | 'queued' | 'error' | 'aborted'> {
  // Stale controller left after a crashed turn — clear it so we can start again.
  if (activeStreamControllers.has(sessionId) && !chatRuntime.isSessionStreaming(sessionId)) {
    activeStreamControllers.delete(sessionId);
  }
  // A turn is genuinely in flight: do not open a second stream (silent drop).
  // Caller should queue via the backend queue path instead.
  if (activeStreamControllers.has(sessionId) && chatRuntime.isSessionStreaming(sessionId)) {
    console.warn('[startChatStream] session already streaming — refusing duplicate turn', sessionId);
    return 'queued';
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

  const { handlers, finalize } = bindTurnStreamHandlers({
    sessionId,
    assistantMsgId,
    initialMessages: params.chatHistory,
    turn,
  });

  try {
    const session = await params.ensureWorkbenchSession();
    if (!session) {
      try { handlers.onError?.({ message: 'Could not initialize Workbench session' }); } catch { /* silent */ }
      finalize('error');
      activeStreamControllers.delete(sessionId);
      return 'error';
    }

    chatRuntime.setTransport(turn.turnId, 'http');

    const handoffSummary =
      params.handoffSummary || takeHandoffSummary(sessionId) || undefined;

    const startResult = await streamWorkbenchChat({
      sessionId: session.id,
      message: params.message,
      provider: params.provider,
      agentId: params.agentId,
      guardMode: params.guardMode as WorkbenchMode | undefined,
      effort: params.effort,
      thinkingEnabled: params.thinkingEnabled,
      model: params.model,
      modelProvider: params.modelProvider,
      handoffSummary,
    }, handlers, abortController.signal);

    // Backend queued because another turn is active — keep a calm note, not an error.
    if (startResult?.queued) {
      updateSessionStreamState(sessionId, prev => ({
        messages: prev.messages
          .map(msg =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content:
                    'Your message is queued and will run when the current response finishes.',
                }
              : msg
          )
          .filter(msg => !(msg.id === assistantMsgId && !msg.content)),
      }));
      // Part 26 7.4: 'queued' — finalize for cleanup WITHOUT the
      // response-complete chime/OS notification (the real reply hasn't
      // happened; the queued turn's own finalize will chime).
      finalize('queued');
      activeStreamControllers.delete(sessionId);
      clearSessionStatus(sessionId);
      return 'queued';
    }

    // The POST handler returns { sinceSeq } JSON immediately and runs the
    // generation in the background. Live events are delivered via the
    // separate /api/workbench/chat/stream SSE channel — attach it now.
    // Drop any durable subscriber first so we never hold two SSEs for one wb.
    if (hasSessionSubscriber(session.id)) {
      detachSessionSubscriber(session.id);
    }
    if (startResult?.consumedViaPost) {
      // Events were already delivered through the POST response body.
    } else {
      const reconnectSinceSeq = Number.isFinite(startResult?.sinceSeq)
        ? startResult.sinceSeq
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
    return abortController.signal.aborted ? 'aborted' : 'started';
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      clearSessionStatus(sessionId);
      finalize('aborted');
      return 'aborted';
    }
    console.error('[startChatStream] error:', e);
    const errorMsg = e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'Unknown error';
    // The error is rendered as a real error block (via onError) — no inline
    // ⚠️ text appended to the bubble content.
    try { handlers.onError?.({ message: errorMsg }); } catch { /* silent */ }
    finalize('error');
    return 'error';
  } finally {
    activeStreamControllers.delete(sessionId);
  }
}

// Stop/abort generation for a session
export async function stopChatStream(sessionId: string) {
  const uiSessionId = resolveUiSessionId(sessionId);
  const wbSessionId = resolveWorkbenchSessionId(sessionId);

  for (const id of new Set([sessionId, uiSessionId, wbSessionId].filter(Boolean))) {
    const controller = activeStreamControllers.get(id);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(id);
    }
    chatRuntime.abortSession(id);
    if (hasSessionSubscriber(id)) {
      detachSessionSubscriber(id);
    }
  }

  clearSessionStatus(uiSessionId);
  clearSessionStatus(wbSessionId);
  clearActiveChatStream(sessionId, uiSessionId, wbSessionId);

  // Tell the backend to stop and free the in-flight slot immediately.
  // Always prefer the workbench id — `_activeStreams` is keyed by wb_*.
  // The queue is PRESERVED: stopping (e.g. to switch models) must not
  // destroy queued follow-ups — they drain into the next turn (backend
  // in-loop drain) or are re-sent by useChatSend's fallback drain.
  try {
    await workbenchClient.stopChat(wbSessionId, /* preserveQueue */ true);
  } catch (err) {
    console.warn('Failed to notify backend of stop:', err);
  }
}

// Reconnect/sync stream with the backend
export async function reconnectChatStream(
  sessionOrWorkbenchId: string,
  _ensureWorkbenchSession: () => Promise<WorkbenchSession | null>
) {
  // Accept either id: the store / runtime / controllers are keyed by the UI
  // sess_* id; the SSE API and lastSeq are keyed by the workbench wb_* id.
  const uiSessionId = resolveUiSessionId(sessionOrWorkbenchId);
  const wbSessionId = resolveWorkbenchSessionId(sessionOrWorkbenchId);

  if (activeStreamControllers.has(uiSessionId)) {
    // Already active
    return;
  }

  // The durable background subscriber must never share a session with a
  // per-turn consumer — two SSEs on one session would race on event
  // application. Detach it here; the idle effect re-attaches when this
  // turn ends.
  if (hasSessionSubscriber(wbSessionId)) {
    detachSessionSubscriber(wbSessionId);
  }

  const state = getOrInitSessionStreamState(uiSessionId);
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
    sessionId: uiSessionId,
    assistantMsgId,
    transport: 'none',
  });

  // Use the turn's controller so aborting the turn also cancels fetches.
  const abortController = turn.controller;
  activeStreamControllers.set(uiSessionId, abortController);

  const { handlers, finalize } = bindTurnStreamHandlers({
    sessionId: uiSessionId,
    assistantMsgId,
    initialMessages,
    turn,
  });

  // The per-turn handler bundle has no onSeq — advance the persisted
  // lastSeq ourselves so a second reconnect never replays already-applied
  // events (subagent/browser events would otherwise double-apply).
  const originalOnSeq = handlers.onSeq;
  handlers.onSeq = (seq: number) => {
    advanceSessionSubscriberLastSeq(wbSessionId, seq);
    originalOnSeq?.(seq);
  };

  try {
    chatRuntime.setTransport(turn.turnId, 'http');

    const lastSeq = getSessionSubscriberLastSeq(wbSessionId);
    await streamWorkbenchReconnect(wbSessionId, handlers, abortController.signal, lastSeq || undefined);
    finalize(abortController.signal.aborted ? 'aborted' : 'done');
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      clearSessionStatus(uiSessionId);
      finalize('aborted');
      return;
    }
    console.warn('Reconnect error:', e);
    finalize('done');
  } finally {
    activeStreamControllers.delete(uiSessionId);
  }
}
