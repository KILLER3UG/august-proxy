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
import { streamWorkbenchChat, streamWorkbenchReconnect, workbenchClient } from '@/api/workbench';
import { setSessionStatus, clearSessionStatus } from '@/store/sessions';
import { chatRuntime } from '../chat-runtime';
import {
  getOrInitSessionStreamState,
  updateSessionStreamState,
} from './session-stream-store';
import { activeStreamControllers } from './active-stream-controllers';
import { bindTurnStreamHandlers } from './bind-turn-handlers';
import { getSessionSubscriberLastSeq } from './session-subscriber';

// Start a new chat generation
export async function startChatStream(
  sessionId: string,
  params: {
    message: string;
    chatHistory: ChatMessage[];
    workbenchMode: WorkbenchMode;
    effort: EffortLevel;
    model: string | undefined;
    modelProvider: string | undefined;
    provider?: string;
    agentId?: string;
    guardMode?: string;
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
      updateSessionStreamState(sessionId, prev => ({
        messages: prev.messages.map(msg =>
          msg.id === assistantMsgId
            ? { ...msg, content: '⚠️ Could not initialize Workbench session. Check that the backend is running.' }
            : msg
        )
      }));
      try { handlers.onError?.({ message: 'Could not initialize Workbench session' }); } catch { /* silent */ }
      finalize('error');
      activeStreamControllers.delete(sessionId);
      return 'error';
    }

    chatRuntime.setTransport(turn.turnId, 'http');

    const startResult = await streamWorkbenchChat({
      sessionId: session.id,
      message: params.message,
      provider: params.provider,
      agentId: params.agentId,
      guardMode: params.guardMode as WorkbenchMode | undefined,
      effort: params.effort,
      model: params.model,
      modelProvider: params.modelProvider,
    }, handlers, abortController.signal);

    // Backend queued because another turn is active — finalize the empty
    // assistant placeholder without hanging on SSE.
    if (startResult?.queued) {
      updateSessionStreamState(sessionId, prev => ({
        messages: prev.messages
          .map(msg =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content:
                    '⏳ A response is already in progress. Your message was queued and will run when it finishes.',
                }
              : msg
          )
          // Drop empty placeholder assistants if we added one
          .filter(msg => !(msg.id === assistantMsgId && !msg.content)),
      }));
      finalize('done');
      activeStreamControllers.delete(sessionId);
      clearSessionStatus(sessionId);
      return 'queued';
    }

    // The POST handler returns { sinceSeq } JSON immediately and runs the
    // generation in the background. Live events are delivered via the
    // separate /api/workbench/chat/stream SSE channel — attach it now.
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
    updateSessionStreamState(sessionId, prev => ({
      messages: prev.messages.map(msg =>
        msg.id === assistantMsgId
          ? { ...msg, content: (msg.content || '') + `\n\n⚠️ Could not generate a response: ${errorMsg}` }
          : msg
      )
    }));
    try { handlers.onError?.({ message: errorMsg }); } catch { /* silent */ }
    finalize('error');
    return 'error';
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
    await workbenchClient.stopChat(wbSessionId);
  } catch (err) {
    console.warn('Failed to notify backend of stop:', err);
  }
}

// Reconnect/sync stream with the backend
export async function reconnectChatStream(
  sessionId: string,
  _ensureWorkbenchSession: () => Promise<WorkbenchSession | null>
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

  const { handlers, finalize } = bindTurnStreamHandlers({
    sessionId,
    assistantMsgId,
    initialMessages,
    turn,
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
