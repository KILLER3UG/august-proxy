/* Workbench chat streaming — POST /chat, SSE reconnect, plan decision streams.
 * Reads named SSE frames and dispatches them via streamEvents. */

import type { WorkbenchEventHandlers, WorkbenchGuardMode, WorkbenchTurnUsage } from '@/types/workbench';
import { dispatchWorkbenchEvent } from './streamEvents';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
}

export interface StreamWorkbenchChatParams {
  sessionId: string;
  message: string;
  provider?: string;
  agentId?: string;
  guardMode?: WorkbenchGuardMode;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** When false, skip extended thinking / reasoning for this turn. */
  thinkingEnabled?: boolean;
  model?: string;
  /** Selected provider id for the model — helps the backend route when the
   *  model id is ambiguous across providers. */
  modelProvider?: string;
  /** Brief of prior interrupted turn when switching models after cancel. */
  handoffSummary?: string;
}

/**
 * Stream a Workbench chat turn. Kicks off a new generation via POST
 * /api/workbench/chat and returns the starting `sinceSeq` so the caller
 * can attach an SSE subscriber that won't replay events already seen.
 * The function awaits the response body for backwards compatibility —
 * older callers consume events from the POST stream itself, newer
 * callers open /api/workbench/chat/stream with `sinceSeq` and ignore
 * whatever this function returns from the body.
 */
export async function streamWorkbenchChat(
  params: StreamWorkbenchChatParams,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal
): Promise<{ sinceSeq?: number; consumedViaPost?: boolean; queued?: boolean; status?: string; message?: string }> {
  const res = await fetch('/api/workbench/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      message: params.message,
      provider: params.provider || '',
      agentId: params.agentId,
      guardMode: params.guardMode,
      effort: params.effort,
      thinkingEnabled: params.thinkingEnabled,
      model: params.model,
      modelProvider: params.modelProvider,
      handoffSummary: params.handoffSummary || undefined,
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const msg = `Workbench chat failed: ${res.status} ${errText}`;
    handlers.onError?.({ message: msg });
    // Throw so callers do NOT open an SSE subscriber for a turn that never started.
    throw new Error(msg);
  }

  // New contract: the POST returns a JSON body with the `sinceSeq` cursor
  // for the live SSE stream. Older servers (or proxies) may still return
  // an SSE stream — fall back to parsing it as before.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await res.json()) as {
        sinceSeq?: number;
        status?: string;
        queuedMessageId?: string;
        message?: string;
      };
      // Backend queues when another turn is already in flight — do not treat
      // that as a workbench error (the message was accepted into the queue).
      if (body?.status === 'queued') {
        return { queued: true, status: 'queued', message: body.message };
      }
      if (Number.isFinite(body?.sinceSeq)) {
        handlers.onStarted?.({ sinceSeq: body.sinceSeq });
        return { sinceSeq: body.sinceSeq, status: body.status };
      }
    } catch (_) {
      // Fall through to legacy SSE parsing.
    }
    // JSON response but no valid sinceSeq — return 0 so the caller
    // reconnects and replays from the current event log position.
    // Do NOT call onDone here — that would finalize an empty assistant
    // message when the SSE subscriber hasn't been attached yet.
    console.warn('[streamWorkbenchChat] POST returned JSON without a valid sinceSeq — reconnecting from seq 0');
    return { sinceSeq: 0 };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    handlers.onDone?.();
    return {};
  }

  try {
    const receivedTerminalEvent = await readSseStream(reader, handlers, signal);
    if (!receivedTerminalEvent) {
      handlers.onError?.({ message: 'Stream ended without completion event — response may be incomplete' });
    }
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    handlers.onError?.({ message: e instanceof Error ? e.message : 'Stream read error' });
  }
  // Events were consumed from the POST response body (legacy SSE path).
  // Tell the caller not to reconnect — events are already delivered.
  return { consumedViaPost: true };
}

/** Parse a ReadableStream of SSE frames and dispatch each event.
 *  Returns true if a terminal event (done / error / aborted) was seen. */
async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let receivedTerminalEvent = false;

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    throwIfAborted(signal);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineStart = 0;
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n', lineStart)) >= 0) {
      const line = buffer.slice(lineStart, newlineIdx).trim();
      lineStart = newlineIdx + 1;
      if (!line) {
        currentEvent = '';
        continue;
      }
      if (line.startsWith(':')) continue; // SSE comment

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('id:')) {
        const idStr = line.slice(3).trim();
        const n = Number(idStr);
        if (Number.isFinite(n) && handlers.onSeq) handlers.onSeq(n);
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        try {
          throwIfAborted(signal);
          const payload = JSON.parse(dataStr) as Record<string, unknown>;
          // Track terminal events — if the stream closes without one,
          // the response is likely incomplete (SSE connection dropped).
          if (currentEvent === 'done' || currentEvent === 'error' || currentEvent === 'aborted') {
            receivedTerminalEvent = true;
          }
          dispatchWorkbenchEvent(currentEvent, payload, handlers);
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          // Ignore non-JSON data lines
        }
      }
    }
    buffer = buffer.slice(lineStart);
  }

  return receivedTerminalEvent;
}

/**
 * Subscribe to the live Workbench chat SSE stream for a session, starting
 * after `sinceSeq`. Retries with exponential backoff when the connection
 * drops without a terminal event (done / error / aborted).
 *
 * Durable per-session subscribers can pass `maxRetries: 0` for an unbounded
 * budget (capped backoff); per-turn callers keep the default bounded budget.
 */
export async function streamWorkbenchReconnect(
  sessionId: string,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal,
  sinceSeq?: number,
  options?: { maxRetries?: number }
): Promise<void> {
  let currentSeq = sinceSeq;

  // Wrap onSeq to capture the latest sequence number as events flow
  const originalOnSeq = handlers.onSeq;
  const wrappedHandlers = {
    ...handlers,
    onSeq: (seq: number) => {
      currentSeq = seq;
      originalOnSeq?.(seq);
    }
  };

  // Retry budget. The durable per-session subscriber (which exists only to
  // keep the SSE stream bound to the session across tab switches / drops)
  // is given an effectively-unbounded budget with capped backoff: the
  // backend ALWAYS emits a terminal event (done/error/aborted) when the
  // turn ends, so retries converge and never spin forever against a dead
  // backend (the POST /chat that started the turn fails fast first).
  // Per-turn callers keep the default bounded budget so a transient user
  // error surfaces instead of silently retrying.
  const maxRetries = options?.maxRetries ?? 10;
  // Backoff is capped so even unbounded retry doesn't stall for minutes.
  const maxBackoffMs = 15000;
  let retryCount = 0;
  const baseDelayMs = 1000;

  while (true) {
    if (signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    try {
      const qs = new URLSearchParams({ sessionId });
      if (Number.isFinite(currentSeq)) {
        qs.set('sinceSeq', String(currentSeq));
      }

      const res = await fetch(`/api/workbench/chat/stream?${qs.toString()}`, { signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Reconnect stream failed: ${res.status} ${errText}`);
      }

      // Guard against non-SSE responses (e.g. HTML error page from a 404 SPA
      // fallback). If we get HTML instead of SSE, bail early with a clear error
      // rather than trying to parse HTML line-by-line as SSE events.
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error('Stream endpoint returned HTML (expected SSE). The backend may be unavailable — try refreshing.');
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('ReadableStream reader not available');
      }

      // Reset retry count on successful connection establishment
      retryCount = 0;

      // Intercept terminal handlers so reconnect stops when the turn ends.
      let terminalSeen = false;
      const streamHandlers = {
        ...wrappedHandlers,
        onDone: (data?: { usage?: WorkbenchTurnUsage }) => {
          terminalSeen = true;
          wrappedHandlers.onDone?.(data);
        },
        onError: (err: unknown) => {
          // If we see a terminal error from the backend, we don't auto-retry.
          terminalSeen = true;
          const msg =
            err instanceof Error
              ? err.message
              : typeof err === 'object' && err !== null && 'message' in err
                ? String((err as Record<string, unknown>).message)
                : String(err);
          wrappedHandlers.onError?.({ message: msg });
        }
      };

      const receivedTerminalEvent = await readSseStream(reader, streamHandlers, signal);

      // If we saw a terminal event (either returned true from readSseStream or flag was set),
      // we stop retrying and return.
      if (receivedTerminalEvent || terminalSeen || signal?.aborted) {
        break;
      }

      // Otherwise, the connection dropped prematurely without a terminal event.
      throw new Error('Stream ended prematurely without a completion event');

    } catch (e: unknown) {
      if ((e instanceof DOMException && e.name === 'AbortError') || signal?.aborted) {
        throw new DOMException('Request aborted', 'AbortError');
      }

      retryCount++;
      // Unbounded retry (subscriber path) never hits this ceiling, so
      // the turn stays alive across transient drops. Bounded callers
      // surface the error once exhausted.
      if (maxRetries > 0 && retryCount > maxRetries) {
        const errMsg =
          e instanceof Error
            ? e.message
            : typeof e === 'object' && e !== null && 'message' in e
              ? String((e as Record<string, unknown>).message)
              : String(e);
        console.error(`[streamWorkbenchReconnect] Max retries reached (${maxRetries}). Connection failed:`, e);
        handlers.onError?.({ message: errMsg });
        break;
      }

      const delay = Math.min(maxBackoffMs, baseDelayMs * Math.pow(2, retryCount - 1) + Math.random() * 1000);
      const budgetLabel = maxRetries > 0 ? `attempt ${retryCount}/${maxRetries}` : `attempt ${retryCount} (unbounded)`;
      const errMsg =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null && 'message' in e
            ? String((e as Record<string, unknown>).message)
            : String(e);
      console.warn(`[streamWorkbenchReconnect] Connection lost. Retrying in ${Math.round(delay)}ms (${budgetLabel}). Error:`, errMsg);

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(timeout);
          reject(new DOMException('Request aborted', 'AbortError'));
        });
      });
    }
  }
}

/**
 * Stream a plan revision turn. Reuses the chat SSE endpoint with a feedback
 * marker so the model produces a thinking block + revised plan (via
 * august__submit_plan or inline assistant text).
 */
export async function streamWorkbenchRevision(
  sessionId: string,
  feedback: string,
  handlers: WorkbenchEventHandlers = {},
  signal?: AbortSignal,
): Promise<{ sinceSeq?: number }> {
  return streamWorkbenchChat({
    sessionId,
    message: [
      '[Revision request]',
      `User feedback: ${feedback}`,
      'Emit a short thinking block summarising the user feedback, then either:',
      '(a) call the august__submit_plan tool with a revised plan (this re-opens the plan banner), or',
      '(b) emit the revised plan inline as normal assistant text.',
      'Either way, end with a brief final paragraph confirming the revision and asking the user to review.',
    ].join(' '),
  }, handlers, signal);
}

export type PlanDecision = 'accept' | 'accept-and-implement' | 'reject';

const PLAN_DECISION_MESSAGES: Record<PlanDecision, string> = {
  'accept': [
    '[Plan accepted]',
    'The user accepted the plan but has NOT granted implementation yet.',
    'Emit a short thinking block summarising the approved scope, then a brief final paragraph confirming approval and asking what to do next.',
    'Do NOT call any tools — the user explicitly chose "accept without implementation".',
  ].join(' '),
  'accept-and-implement': [
    '[Plan accepted with implementation]',
    'The user accepted the plan and granted you Full access.',
    'Emit a thinking block that enumerates each step in the plan in order.',
    'Then make one tool call per step (no batching). When all steps are done, emit a final summary that lists what was changed and what remains.',
  ].join(' '),
  'reject': [
    '[Plan rejected]',
    'The user rejected the plan.',
    'Emit a short thinking block explaining what was rejected and why, then a final paragraph acknowledging the rejection and offering to try a different direction.',
    'Do NOT call any tools — the user explicitly chose "reject".',
  ].join(' '),
};

/**
 * Notify the Workbench model about a plan decision (accept / accept-and-implement /
 * reject) by sending a marker-prefixed chat message. The model uses the marker
 * to recognise the decision and behave accordingly (acknowledge-only vs.
 * proceed-with-implementation vs. discard-and-wait).
 *
 * The full SSE response stream is forwarded to the caller via the standard
 * `WorkbenchEventHandlers` so the chat thread can render the model's reply
 * and any tool calls in real time.
 */
export async function streamPlanDecision(
  sessionId: string,
  decision: PlanDecision,
  handlers: WorkbenchEventHandlers = {},
  signal?: AbortSignal,
): Promise<{ sinceSeq?: number }> {
  return streamWorkbenchChat({
    sessionId,
    message: PLAN_DECISION_MESSAGES[decision],
  }, handlers, signal);
}
