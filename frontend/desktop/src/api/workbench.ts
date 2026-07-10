/* Workbench API client — talks to backend /api/workbench/* endpoints */
/* Uses named SSE events (event: text, event: toolUse, etc.) per backend. */

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

export interface CreateWorkbenchSessionParams {
  provider?: 'claude' | 'codex';
  agentId?: string;
  guardMode?: WorkbenchGuardMode;
}

export async function setWorkbenchGuardMode(
  sessionId: string,
  guardMode: WorkbenchGuardMode
): Promise<WorkbenchSession> {
  const res = await fetch('/api/workbench/guard-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, guardMode }),
  });
  if (!res.ok) throw new Error(`setWorkbenchGuardMode failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
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
  const res = await fetch('/api/workbench/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: params.provider || 'claude',
      agentId: params.agentId || 'build',
      guardMode: params.guardMode,
    }),
  });
  if (!res.ok) throw new Error(`createWorkbenchSession failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

export async function getWorkbenchSessions(): Promise<WorkbenchSession[]> {
  const res = await fetch('/api/workbench/sessions');
  if (!res.ok) throw new Error(`getWorkbenchSessions failed: ${res.status}`);
  const data = (await res.json()) as { sessions?: WorkbenchSession[] } | WorkbenchSession[];
  return (Array.isArray(data) ? data : data.sessions) || [];
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch(`/api/workbench/session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getWorkbenchSession failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
}

export interface StreamWorkbenchChatParams {
  sessionId: string;
  message: string;
  provider?: 'claude' | 'codex';
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
): Promise<{ sinceSeq?: number; consumedViaPost?: boolean }> {
  const res = await fetch('/api/workbench/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      message: params.message,
      provider: params.provider || 'claude',
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
    handlers.onError?.({ message: `Workbench chat failed: ${res.status} ${errText}` });
    return {};
  }

  // New contract: the POST returns a JSON body with the `sinceSeq` cursor
  // for the live SSE stream. Older servers (or proxies) may still return
  // an SSE stream — fall back to parsing it as before.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const body = (await res.json()) as { sinceSeq?: number };
      if (Number.isFinite(body?.sinceSeq)) {
        handlers.onStarted?.({ sinceSeq: body.sinceSeq });
        return { sinceSeq: body.sinceSeq };
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
  const res = await fetch('/api/workbench/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`stopWorkbenchChat failed: ${res.status}`);
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
}

/** Submit a follow-up message that will be delivered to the model mid-
 *  response. The next time the chat loop's iteration boundary fires
 *  (after toolResults or after the model emits a text-only turn), the
 *  queued entries are drained and the model decides whether to act on
 *  them. */
export async function queueWorkbenchMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
): Promise<QueuedUserMessage> {
  const res = await fetch('/api/workbench/chat/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text, attachments: attachments ?? [] }),
  });
  if (!res.ok) throw new Error(`queueWorkbenchMessage failed: ${res.status}`);
  return res.json() as Promise<QueuedUserMessage>;
}

/** Cancel a single queued message before the model receives it. */
export async function dequeueWorkbenchMessage(
  sessionId: string,
  messageId: string,
): Promise<void> {
  const res = await fetch(
    `/api/workbench/chat/queue/${encodeURIComponent(messageId)}?sessionId=${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`dequeueWorkbenchMessage failed: ${res.status}`);
}

/** Hydrate the local queue state from the server (used on mount and
 *  after session switch). */
export async function getQueuedWorkbenchMessages(
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  const res = await fetch(
    `/api/workbench/chat/queue?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) throw new Error(`getQueuedWorkbenchMessages failed: ${res.status}`);
  const data = (await res.json()) as { messages?: QueuedUserMessage[] };
  return Array.isArray(data?.messages) ? data.messages : [];
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
  const res = await fetch('/api/workbench/plan/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`approveWorkbenchPlan failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

export async function rejectWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch('/api/workbench/plan/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`rejectWorkbenchPlan failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
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
  provider?: 'claude' | 'codex';
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
      provider: params.provider || 'claude',
      agentId: params.agentId || 'build',
    }),
  });
  if (!res.ok) throw new Error(`resetWorkbenchSession failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

export async function listWorkbenchAgents(activeAgentId = 'build'): Promise<WorkbenchAgentRegistry> {
  const res = await fetch(`/api/workbench/agents?active=${encodeURIComponent(activeAgentId)}`);
  if (!res.ok) throw new Error(`listWorkbenchAgents failed: ${res.status}`);
  return res.json() as Promise<WorkbenchAgentRegistry>;
}

export async function listWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  const res = await fetch('/api/workbench/capabilities');
  if (!res.ok) throw new Error(`listWorkbenchCapabilities failed: ${res.status}`);
  return res.json() as Promise<WorkbenchCapabilities>;
}

export interface AnswerWorkbenchBtwParams {
  sessionId: string;
  question: string;
  provider?: 'claude' | 'codex';
  agentId?: string;
}

export async function answerWorkbenchBtw(
  params: AnswerWorkbenchBtwParams
): Promise<WorkbenchBtwResult> {
  const res = await fetch('/api/workbench/btw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      question: params.question,
      provider: params.provider || 'claude',
      agentId: params.agentId,
    }),
  });
  if (!res.ok) throw new Error(`answerWorkbenchBtw failed: ${res.status}`);
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
