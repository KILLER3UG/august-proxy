/* Workbench API client — talks to backend /api/workbench/* endpoints */
/* Uses named SSE events (event: text, event: toolUse, etc.) per backend. */
/* CRUD/queue/plan helpers below delegate to WorkbenchClient; streaming    */
/* and SSE dispatch stay in this module.                                   */

import type {
  WorkbenchSession,
  WorkbenchAgentRegistry,
  WorkbenchCapabilities,
  WorkbenchBtwResult,
  WorkbenchEventHandlers,
  WorkbenchGuardMode,
} from '@/types/workbench';
import type { FileAttachment } from '@/types/chat';
import { WorkbenchEventSchema } from './schemas/workbench';
import { workbenchClient } from './workbench/WorkbenchClient';

export interface CreateWorkbenchSessionParams {
  provider?: string;
  agentId?: string;
  guardMode?: WorkbenchGuardMode;
}

export async function setWorkbenchGuardMode(
  sessionId: string,
  guardMode: WorkbenchGuardMode
): Promise<WorkbenchSession> {
  return workbenchClient.setGuardMode(sessionId, guardMode);
}

export async function confirmWorkbenchMutation(
  token: string,
  handlers: WorkbenchEventHandlers
): Promise<void> {
  const res = await fetch('/api/workbench/mutations/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    handlers.onError?.({ message: (data.message as string) || `confirmWorkbenchMutation failed: ${res.status}` });
    return;
  }

  const data = (await res.json()) as Record<string, unknown>;
  handlers.onToolResult?.({
    id: token,
    content: JSON.stringify({ type: 'mutation_confirmation_result', result: data }, null, 2),
    isError: !!(data.blocked as boolean) || !!(data.error as boolean),
  });
  handlers.onDone?.();
}

export async function createWorkbenchSession(
  params: CreateWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  return workbenchClient.createSession(params);
}

export async function getWorkbenchSessions(): Promise<WorkbenchSession[]> {
  return workbenchClient.listSessions();
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.getSession(sessionId);
}

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
  model?: string;
  /** Selected provider id for the model — helps the backend route when the
   *  model id is ambiguous across providers. */
  modelProvider?: string;
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
): Promise<{ sinceSeq?: number; consumedViaPost?: boolean; queued?: boolean; status?: string }> {
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
      model: params.model,
      modelProvider: params.modelProvider,
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
      // Backend queues when another turn is already in flight — do not open
      // a second SSE wait that looks like a hung empty response.
      if (body?.status === 'queued') {
        handlers.onError?.({
          message:
            body.message ||
            'A response is already in progress — your message was queued and will run next.',
        });
        return { queued: true, status: 'queued' };
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

      // Wrap readSseStream. It will return when the stream ends.
      // We want to know if it ended with a terminal event.
      // We can intercept terminal events to stop retrying.
      let terminalSeen = false;
      const streamHandlers = {
        ...wrappedHandlers,
        onDone: () => {
          terminalSeen = true;
          wrappedHandlers.onDone?.();
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

export async function stopWorkbenchChat(sessionId: string): Promise<void> {
  return workbenchClient.stopChat(sessionId);
}

/* ── Mid-response queued messages ─────────────────────────────────────── */

/** A user message that was queued while the model was streaming. The
 *  chat loop drains the queue at the next iteration boundary and wraps
 *  each entry with <queued_message> tags so the model can distinguish
 *  the queued text from a fresh top-of-conversation prompt. */
export interface QueuedUserMessage {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: string;
  kind?: 'queue' | 'steer';
}

/** Submit a follow-up message that will be delivered to the model mid-
 *  response. The next time the chat loop's iteration boundary fires
 *  (after toolResults or after the model emits a text-only turn), the
 *  queued entries are drained and the model decides whether to act on
 *  them.
 *
 *  kind:
 *  - ``queue`` — ordinary follow-up
 *  - ``steer`` — mid-run course correction (priority + stronger prompt)
 */
export async function queueWorkbenchMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
  kind: 'queue' | 'steer' = 'queue',
): Promise<QueuedUserMessage> {
  return workbenchClient.queueMessage(sessionId, text, attachments, kind);
}

/** Mid-run steer — redirect August without stopping the current turn. */
export async function steerWorkbenchMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
): Promise<QueuedUserMessage> {
  return workbenchClient.steerMessage(sessionId, text, attachments);
}

/** Cancel a single queued message before the model receives it. */
export async function dequeueWorkbenchMessage(
  sessionId: string,
  messageId: string,
): Promise<void> {
  return workbenchClient.dequeueMessage(sessionId, messageId);
}

/** Clear the entire mid-response queue for a session. */
export async function clearQueuedWorkbenchMessages(
  sessionId: string,
): Promise<{ cleared: number }> {
  return workbenchClient.clearQueue(sessionId);
}

/** Reorder queued messages (drag reorder). `order` is message ids in desired order. */
export async function reorderQueuedWorkbenchMessages(
  sessionId: string,
  order: string[],
): Promise<QueuedUserMessage[]> {
  return workbenchClient.reorderQueue(sessionId, order);
}

/** Edit the text of a queued message before the model receives it. */
export async function updateQueuedWorkbenchMessage(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<QueuedUserMessage> {
  return workbenchClient.updateQueuedMessage(sessionId, messageId, text);
}

/** Hydrate the local queue state from the server (used on mount and
 *  after session switch). */
export async function getQueuedWorkbenchMessages(
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  return workbenchClient.listQueue(sessionId);
}

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  summary: string;
};

/** Setup doctor: backend, disk, MCP, OAuth readiness. */
export async function getWorkbenchDoctor(): Promise<DoctorReport> {
  return workbenchClient.doctor();
}

/** Validate an incoming SSE frame against the WorkbenchEvent Zod schema.
 *  Logs a console warning on mismatch (instead of throwing) so the stream
 *  stays resilient to minor backend drift. A mismatch here is a signal
 *  to update the schema or the corresponding TypeScript type. */
function validateWorkbenchEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  const result = WorkbenchEventSchema.safeParse({ type: event, ...payload });
  if (!result.success) {
    console.warn(
      `[workbench] SSE event '${event}' failed schema validation:`,
      result.error.issues.slice(0, 3),
    );
  }
}

function dispatchWorkbenchEvent(
  event: string,
  payload: Record<string, unknown>,
  handlers: WorkbenchEventHandlers
): void {
  validateWorkbenchEvent(event, payload);
  const p = payload;
  switch (event) {
    case 'thinking':
      handlers.onThinking?.({ content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? '') });
      break;
    case 'text':
    case 'content':
    case 'finalOutput':
      handlers.onText?.({ content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? '') });
      break;
    case 'toolUse':
      handlers.onToolUse?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
      });
      break;
    case 'toolCall': {
      let input: Record<string, unknown> = {};
      try {
        input = typeof p?.input === 'string' ? (JSON.parse(p.input) as Record<string, unknown>) : ((p?.input as Record<string, unknown>) ?? {});
      } catch {
        input = {};
      }
      handlers.onToolUse?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input,
      });
      break;
    }
    case 'toolResult':
      handlers.onToolResult?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content: p?.content,
        isError: p?.isError as boolean | undefined,
        providerSetup: p?.providerSetup,
      });
      break;
    case 'tool_progress': {
      const phase = (typeof p?.phase === 'string' ? p.phase : JSON.stringify(p?.phase ?? 'done')) as 'reading' | 'read' | 'running' | 'done' | 'error';
      handlers.onToolProgress?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        phase,
        paths: Array.isArray(p?.paths) ? (p.paths as string[]) : undefined,
        path: typeof p?.path === 'string' ? p.path : undefined,
        message: typeof p?.message === 'string' ? p.message : undefined,
      });
      break;
    }
    case 'session':
      handlers.onSession?.(p as unknown as WorkbenchSession);
      break;
    case 'btw':
      handlers.onBtw?.(p as unknown as WorkbenchBtwResult);
      break;
    case 'compaction':
      handlers.onCompaction?.({
        headCount: Number(p?.headCount) || 0,
        tailCount: Number(p?.tailCount) || 0,
        compressedCount: Number(p?.compressedCount) || 0,
        originalTokens: Number(p?.originalTokens) || 0,
        compressedTokens: Number(p?.compressedTokens) || 0,
        underThreshold: p?.underThreshold === true,
        threshold: Number(p?.threshold) || undefined,
      });
      break;
    case 'checkpoint':
      handlers.onCheckpoint?.({
        id: typeof p?.id === 'string' ? p.id : undefined,
        label: typeof p?.label === 'string' ? p.label : undefined,
        fileCount: Number(p?.fileCount) || undefined,
        toolName: typeof p?.toolName === 'string' ? p.toolName : undefined,
      });
      break;
    case 'prompt':
      handlers.onPrompt?.({
        content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? ''),
        systemPrompt: p?.systemPrompt as string | undefined,
        userMessage: p?.userMessage as string | undefined,
        tokens: p?.tokens as number | undefined,
        toolUseId: p?.toolUseId as string | undefined,
        subagentId: p?.subagentId as string | undefined,
        jobId: p?.jobId as string | undefined,
      });
      break;
    case 'started':
      handlers.onStarted?.({ sinceSeq: p?.sinceSeq as number | undefined });
      break;
    case 'userMessageQueued':
      handlers.onUserMessageQueued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
      break;
    case 'userMessageDequeued':
      handlers.onUserMessageDequeued?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
      });
      break;
    case 'userMessageInjected':
      handlers.onUserMessageInjected?.({
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : JSON.stringify(p?.sessionId ?? ''),
        messageId: typeof p?.messageId === 'string' ? p.messageId : JSON.stringify(p?.messageId ?? ''),
        text: typeof p?.text === 'string' ? p.text : JSON.stringify(p?.text ?? ''),
        queuedAt: typeof p?.queuedAt === 'string' ? p.queuedAt : new Date().toISOString(),
      });
      break;
    case 'subagentStart':
      handlers.onSubagentStart?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        parentJobId: p?.parentJobId !== undefined ? (typeof p.parentJobId === 'string' ? p.parentJobId : JSON.stringify(p.parentJobId)) : null,
        parentToolUseId: p?.parentToolUseId as string | undefined,
        scope: p?.scope as string | undefined,
        depth: Number.isFinite(Number(p?.depth)) ? Number(p.depth) : undefined,
        task: p?.task as string | undefined,
      });
      break;
    case 'subagentDone':
      handlers.onSubagentDone?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        status: (['completed', 'failed', 'cancelled'].includes(p?.status as string)
          ? (p.status as 'completed' | 'failed' | 'cancelled')
          : 'completed'),
        message: p?.message as string | undefined,
        result: p?.result as string | undefined,
      });
      break;
    case 'warning':
      handlers.onWarning?.({
        kind: p?.kind as string | undefined,
        message: p?.message as string | undefined,
        jobId: p?.jobId as string | undefined,
        toolUseId: p?.toolUseId as string | undefined,
        ...p,
      });
      break;
    case 'subagentText':
      handlers.onSubagentText?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        content: typeof p?.content === 'string' ? p.content : JSON.stringify(p?.content ?? ''),
      });
      break;
    case 'subagentToolCall':
      handlers.onSubagentToolCall?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
        status: p?.status as 'running' | 'done' | 'error' | undefined,
      });
      break;
    case 'subagentToolResult':
      handlers.onSubagentToolResult?.({
        jobId: typeof p?.jobId === 'string' ? p.jobId : JSON.stringify(p?.jobId ?? ''),
        agentId: typeof p?.agentId === 'string' ? p.agentId : JSON.stringify(p?.agentId ?? ''),
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        content: p?.content,
        isError: p?.isError as boolean | undefined,
        status: p?.isError ? 'error' : 'done',
      });
      break;
    case 'aborted':
      handlers.onDone?.();
      break;
    case 'browserAction':
      handlers.onBrowserAction?.({
        id: typeof p?.id === 'string' ? p.id : JSON.stringify(p?.id ?? ''),
        name: typeof p?.name === 'string' ? p.name : JSON.stringify(p?.name ?? ''),
        input: (p?.input as Record<string, unknown>) ?? {},
        url: p?.url as string | undefined,
        title: p?.title as string | undefined,
        target: (p?.target as { x: number; y: number; width: number; height: number } | null) ?? null,
        screenshot: (p?.screenshot as { path: string; width: number; height: number } | null) ?? null,
        typed: p?.typed as string | undefined,
        selected: p?.selected as string | undefined,
        scrolled: p?.scrolled as string | undefined,
        status: p?.status === 'error' ? 'error' : 'success',
      });
      break;
    case 'done':
      handlers.onDone?.();
      break;
    case 'error':
      handlers.onError?.({ message: typeof p?.message === 'string' ? p.message : JSON.stringify(p?.message ?? 'Unknown error') });
      break;
    case 'clarifyProposed': {
      const c = (p?.clarify ?? {}) as Record<string, unknown>;
      handlers.onClarifyProposed?.({
        question: typeof c?.question === 'string' ? c.question : undefined,
        choices: Array.isArray(c?.choices) ? (c.choices as string[]) : undefined,
        questions: Array.isArray(c?.questions)
          ? (c.questions as Array<{ question: string; choices?: string[] }>)
          : undefined,
        currentIndex: typeof c?.currentIndex === 'number' ? c.currentIndex : undefined,
        contextSummary: typeof c?.contextSummary === 'string' ? c.contextSummary : undefined,
      });
      break;
    }
  }
}

export async function approveWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.approvePlan(sessionId);
}

export async function rejectWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.rejectPlan(sessionId);
}

export async function streamWorkbenchRevision(
  sessionId: string,
  feedback: string,
  handlers: WorkbenchEventHandlers = {},
  signal?: AbortSignal,
): Promise<{ sinceSeq?: number }> {
  // Reuse the chat SSE endpoint with a feedback marker. The marker
  // tells the model this is a revision request: it should produce a
  // thinking block + a new plan (either by calling august__submit_plan,
  // which makes the banner re-appear, or by emitting the revised plan
  // as normal assistant text inline). No version prefix is added — the
  // plan appears as a regular assistant message.
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

export interface ResetWorkbenchSessionParams {
  sessionId?: string;
  provider?: string;
  agentId?: string;
}

export async function resetWorkbenchSession(
  params: ResetWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  const sid = params.sessionId ? encodeURIComponent(params.sessionId) : '';
  const res = await fetch(`/api/workbench/sessions/${sid}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      provider: params.provider || '',
      agentId: params.agentId || 'build',
    }),
  });
  if (!res.ok) throw new Error(`resetWorkbenchSession failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

/** Delete a workbench session (cascades messages / timeline / usage in SQLite). */
export async function deleteWorkbenchSession(sessionId: string): Promise<void> {
  return workbenchClient.deleteSession(sessionId);
}

/** Rename a workbench session (sidebar title). */
export async function renameWorkbenchSession(
  sessionId: string,
  title: string,
): Promise<WorkbenchSession> {
  return workbenchClient.renameSession(sessionId, title);
}

/** Remove the last user turn (and following assistant/tool messages) on the server. */
export async function undoWorkbenchLastTurn(sessionId: string): Promise<{
  session: WorkbenchSession;
  removed: number;
  message?: string;
}> {
  return workbenchClient.undoLastTurn(sessionId);
}

/** Fork a workbench session (optional upToIndex = last source message to keep). */
export async function branchWorkbenchSession(
  sessionId: string,
  upToIndex?: number | null,
): Promise<WorkbenchSession> {
  return workbenchClient.branchSession(sessionId, upToIndex);
}

/** Force context compression (“Free up chat memory”). */
export async function compactWorkbenchSession(sessionId: string): Promise<{
  session: WorkbenchSession;
  underThreshold?: boolean;
  originalTokens?: number;
  compressedTokens?: number;
  compressedCount?: number;
  headCount?: number;
  tailCount?: number;
  message?: string;
}> {
  return workbenchClient.compactSession(sessionId);
}

export interface WorkbenchCheckpoint {
  id: string;
  sessionId?: string;
  createdAt?: string;
  label?: string;
  fileCount?: number;
  toolName?: string;
}

export async function listWorkbenchCheckpoints(
  sessionId: string,
): Promise<WorkbenchCheckpoint[]> {
  return workbenchClient.listCheckpoints(sessionId);
}

export async function restoreWorkbenchCheckpoint(
  sessionId: string,
  checkpointId: string,
): Promise<{ ok: boolean; message?: string; restored?: number; deleted?: number }> {
  return workbenchClient.restoreCheckpoint(sessionId, checkpointId) as Promise<{
    ok: boolean;
    message?: string;
    restored?: number;
    deleted?: number;
  }>;
}

export interface SessionAgentRow {
  taskId: string;
  agentId: string;
  goal: string;
  status: string;
  elapsed?: number;
  error?: string;
}

export async function listWorkbenchSessionAgents(sessionId: string): Promise<{
  agents: SessionAgentRow[];
  meta: {
    isolateSubagents?: boolean;
    lastCheckpointId?: string;
    lastCheckpointLabel?: string;
  };
}> {
  return workbenchClient.listSessionAgents(sessionId);
}

export async function setIsolateSubagents(
  sessionId: string,
  enabled: boolean,
): Promise<{ ok: boolean; isolateSubagents: boolean }> {
  return workbenchClient.setIsolateSubagents(sessionId, enabled);
}

export async function cancelAllSessionAgents(
  sessionId: string,
): Promise<{ ok: boolean; count: number; cancelled: string[] }> {
  return workbenchClient.cancelAllAgents(sessionId);
}

export async function terminateSessionAgent(
  taskId: string,
): Promise<{ status: string; taskId: string }> {
  return workbenchClient.terminateAgent(taskId);
}

export async function listWorkbenchAgents(activeAgentId = 'build'): Promise<WorkbenchAgentRegistry> {
  return workbenchClient.listAgents(activeAgentId);
}

export async function listWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  return workbenchClient.listCapabilities();
}

export interface AnswerWorkbenchBtwParams {
  sessionId: string;
  question: string;
}

/** BTW uses the session's chat model on the server (same as the last chat turn). */
export async function answerWorkbenchBtw(
  params: AnswerWorkbenchBtwParams
): Promise<WorkbenchBtwResult> {
  const res = await fetch('/api/workbench/btw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      question: params.question,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(
      (typeof detail.detail === 'string' ? detail.detail : null) ||
        `answerWorkbenchBtw failed: ${res.status}`,
    );
  }
  return res.json() as Promise<WorkbenchBtwResult>;
}

/* ── Brain orchestrator settings ──────────────────────────────────────── */

export interface BrainConfig {
  enabled: boolean;
  adaptivePolicy: boolean;
  failureLearning: boolean;
  graphMemory: boolean;
  agentJobs: boolean;
  hierarchicalAgents: boolean;
  adapterParallelTools: boolean;
  parallelReadTools: boolean;
  reviewLearnedGuidelines: boolean;
  maxAgentDepth: number;
  maxWorkbenchToolLoops: number;
}

export type BrainConfigSource = 'persisted' | 'session' | 'fallback';

export interface BrainConfigResponse {
  source: BrainConfigSource;
  config: BrainConfig;
  defaults: BrainConfig;
  sessionId?: string | null;
  session?: { id: string; task: string | null } | null;
}

export async function getBrainConfig(): Promise<BrainConfigResponse> {
  const res = await fetch('/api/brain/config');
  if (!res.ok) throw new Error(`getBrainConfig failed: ${res.status}`);
  return res.json() as Promise<BrainConfigResponse>;
}

export async function saveBrainConfig(updates: Partial<BrainConfig>): Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }> {
  const res = await fetch('/api/brain/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `saveBrainConfig failed: ${res.status}`);
  }
  return res.json() as Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }>;
}

export async function resetBrainConfig(): Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }> {
  const res = await fetch('/api/brain/config/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`resetBrainConfig failed: ${res.status}`);
  return res.json() as Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }>;
}

export async function getBrainConfigFromSession(sessionId: string): Promise<BrainConfigResponse> {
  const res = await fetch(`/api/brain/config/from-session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getBrainConfigFromSession failed: ${res.status}`);
  return res.json() as Promise<BrainConfigResponse>;
}

/* ── Client re-export ─────────────────────────────────────────────────── */
/* Prefer `workbenchClient` at call sites; free functions keep stable names. */
export { WorkbenchClient, workbenchClient } from './workbench/WorkbenchClient';
export { WorkbenchHttpError } from './workbench/http';
