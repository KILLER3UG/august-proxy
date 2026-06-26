/* Workbench API client — talks to backend /api/workbench/* endpoints */
/* Uses named SSE events (event: text, event: tool_use, etc.) per backend. */

import type {
  WorkbenchSession,
  WorkbenchAgentRegistry,
  WorkbenchCapabilities,
  WorkbenchBtwResult,
  WorkbenchEventHandlers,
  WorkbenchGuardMode,
} from '@/types/workbench';

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
  return res.json();
}

export async function confirmWorkbenchMutation(
  token: string,
  handlers: WorkbenchEventHandlers
): Promise<void> {
  const res = await fetch('/api/workbench/confirm-mutation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    handlers.onError?.({ message: data.message || `confirmWorkbenchMutation failed: ${res.status}` });
    return;
  }

  const data = await res.json();
  handlers.onToolResult?.({
    id: token,
    content: JSON.stringify({ type: 'mutation_confirmation_result', result: data }, null, 2),
    is_error: !!data.blocked || !!data.error,
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
  return res.json();
}

export async function getWorkbenchSessions(): Promise<WorkbenchSession[]> {
  const res = await fetch('/api/workbench/sessions');
  if (!res.ok) throw new Error(`getWorkbenchSessions failed: ${res.status}`);
  const data = await res.json();
  return data.sessions || data || [];
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch(`/api/workbench/session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getWorkbenchSession failed: ${res.status}`);
  return res.json();
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
      const body = await res.json();
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

  await readSseStream(reader, handlers, signal);
  // Events were consumed from the POST response body (legacy SSE path).
  // Tell the caller not to reconnect — events are already delivered.
  return { consumedViaPost: true };
}

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let receivedTerminalEvent = false;

  try {
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
            const payload = JSON.parse(dataStr);
            // Track terminal events — if the stream closes without one,
            // the response is likely incomplete (SSE connection dropped).
            if (currentEvent === 'done' || currentEvent === 'error' || currentEvent === 'aborted') {
              receivedTerminalEvent = true;
            }
            dispatchWorkbenchEvent(currentEvent, payload, handlers);
          } catch (e: any) {
            if (e?.name === 'AbortError') throw e;
            // Ignore non-JSON data lines
          }
        }
      }
      buffer = buffer.slice(lineStart);
    }

    // Stream ended but we never saw a terminal event — the connection likely
    // dropped before the backend could signal completion. Report an error so
    // the assistant bubble doesn't stay silently empty or incomplete.
    if (!receivedTerminalEvent) {
      handlers.onError?.({ message: 'Stream ended without completion event — response may be incomplete' });
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    handlers.onError?.({ message: e?.message || 'Stream read error' });
  }
}

export async function streamWorkbenchReconnect(
  sessionId: string,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal,
  sinceSeq?: number
): Promise<void> {
  const qs = new URLSearchParams({ sessionId });
  if (Number.isFinite(sinceSeq)) qs.set('sinceSeq', String(sinceSeq));
  const res = await fetch(`/api/workbench/chat/stream?${qs.toString()}`, { signal });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    handlers.onError?.({ message: `Reconnect stream failed: ${res.status} ${errText}` });
    return;
  }

  // Guard against non-SSE responses (e.g. HTML error page from a 404 SPA
  // fallback). If we get HTML instead of SSE, bail early with a clear error
  // rather than trying to parse HTML line-by-line as SSE events.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const body = await res.text().catch(() => '');
    handlers.onError?.({ message: `Stream endpoint returned HTML (expected SSE). The backend may be unavailable — try refreshing.` });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    handlers.onDone?.();
    return;
  }

  await readSseStream(reader, handlers, signal);
}

export async function stopWorkbenchChat(sessionId: string): Promise<void> {
  const res = await fetch('/api/workbench/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`stopWorkbenchChat failed: ${res.status}`);
}

function dispatchWorkbenchEvent(
  event: string,
  payload: any,
  handlers: WorkbenchEventHandlers
): void {
  switch (event) {
    case 'thinking':
      handlers.onThinking?.({ content: payload?.content || '' });
      break;
    case 'text':
    case 'content':
    case 'final_output':
      handlers.onText?.({ content: payload?.content || '' });
      break;
    case 'tool_use':
      handlers.onToolUse?.({
        id: payload?.id || '',
        name: payload?.name || '',
        input: payload?.input || {},
      });
      break;
    case 'tool_call': {
      let input: Record<string, any> = {};
      try {
        input = typeof payload?.input === 'string' ? JSON.parse(payload.input) : (payload?.input || {});
      } catch {
        input = {};
      }
      handlers.onToolUse?.({
        id: payload?.id || '',
        name: payload?.name || '',
        input,
      });
      break;
    }
    case 'tool_result':
      handlers.onToolResult?.({
        id: payload?.id || '',
        content: payload?.content,
        is_error: payload?.is_error,
      });
      break;
    case 'tool_progress': {
      const phase = (payload?.phase || 'done') as
        'reading' | 'read' | 'running' | 'done' | 'error';
      handlers.onToolProgress?.({
        id: payload?.id || '',
        name: payload?.name || '',
        phase,
        paths: Array.isArray(payload?.paths) ? payload.paths : undefined,
        path: typeof payload?.path === 'string' ? payload.path : undefined,
        message: typeof payload?.message === 'string' ? payload.message : undefined,
      });
      break;
    }
    case 'session':
      handlers.onSession?.(payload as WorkbenchSession);
      break;
    case 'btw':
      handlers.onBtw?.(payload as WorkbenchBtwResult);
      break;
    case 'compaction':
      handlers.onCompaction?.({
        headCount: Number(payload?.headCount) || 0,
        tailCount: Number(payload?.tailCount) || 0,
        compressedCount: Number(payload?.compressedCount) || 0,
        originalTokens: Number(payload?.originalTokens) || 0,
        compressedTokens: Number(payload?.compressedTokens) || 0,
        underThreshold: payload?.underThreshold === true,
        threshold: Number(payload?.threshold) || undefined,
      });
      break;
    case 'prompt':
      handlers.onPrompt?.({
        content: payload?.content || '',
        systemPrompt: payload?.systemPrompt,
        userMessage: payload?.userMessage,
        tokens: payload?.tokens,
        toolUseId: payload?.toolUseId,
        subagentId: payload?.subagentId,
        jobId: payload?.jobId,
      });
      break;
    case 'started':
      handlers.onStarted?.({ sinceSeq: payload?.sinceSeq });
      break;
    case 'subagent_start':
      handlers.onSubagentStart?.({
        jobId: String(payload?.jobId || ''),
        agentId: String(payload?.agentId || ''),
        parentJobId: payload?.parentJobId ?? null,
        parentToolUseId: payload?.parentToolUseId,
        scope: payload?.scope,
        depth: Number.isFinite(payload?.depth) ? Number(payload.depth) : undefined,
        task: payload?.task,
      });
      break;
    case 'subagent_done':
      handlers.onSubagentDone?.({
        jobId: String(payload?.jobId || ''),
        agentId: String(payload?.agentId || ''),
        status: (['completed', 'failed', 'cancelled'].includes(payload?.status)
          ? payload.status
          : 'completed') as 'completed' | 'failed' | 'cancelled',
        message: payload?.message,
        result: payload?.result,
      });
      break;
    case 'warning':
      handlers.onWarning?.({
        kind: payload?.kind,
        message: payload?.message,
        jobId: payload?.jobId,
        toolUseId: payload?.toolUseId,
        ...payload,
      });
      break;
    case 'subagent_text':
      handlers.onSubagentText?.({
        jobId: String(payload?.jobId || ''),
        agentId: String(payload?.agentId || ''),
        content: String(payload?.content || ''),
      });
      break;
    case 'subagent_tool_call':
      handlers.onSubagentToolCall?.({
        jobId: String(payload?.jobId || ''),
        agentId: String(payload?.agentId || ''),
        id: String(payload?.id || ''),
        name: String(payload?.name || ''),
        input: payload?.input || {},
        status: payload?.status,
      });
      break;
    case 'subagent_tool_result':
      handlers.onSubagentToolResult?.({
        jobId: String(payload?.jobId || ''),
        agentId: String(payload?.agentId || ''),
        id: String(payload?.id || ''),
        content: payload?.content,
        is_error: payload?.is_error,
        status: payload?.is_error ? 'error' : 'done',
      });
      break;
    case 'aborted':
      // Aborted is terminal; the runtime treats it like `done`. The
      // explicit `aborted` event lets the runtime distinguish if it wants.
      handlers.onDone?.();
      break;
    case 'done':
      handlers.onDone?.();
      break;
    case 'error':
      handlers.onError?.({ message: payload?.message || 'Unknown error' });
      break;
  }
}

export async function approveWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch('/api/workbench/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`approveWorkbenchPlan failed: ${res.status}`);
  return res.json();
}

export async function rejectWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch('/api/workbench/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`rejectWorkbenchPlan failed: ${res.status}`);
  return res.json();
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
  const res = await fetch('/api/workbench/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      provider: params.provider || 'claude',
      agentId: params.agentId || 'build',
    }),
  });
  if (!res.ok) throw new Error(`resetWorkbenchSession failed: ${res.status}`);
  return res.json();
}

export async function listWorkbenchAgents(activeAgentId = 'build'): Promise<WorkbenchAgentRegistry> {
  const res = await fetch(`/api/workbench/agents?active=${encodeURIComponent(activeAgentId)}`);
  if (!res.ok) throw new Error(`listWorkbenchAgents failed: ${res.status}`);
  return res.json();
}

export async function listWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  const res = await fetch('/api/workbench/capabilities');
  if (!res.ok) throw new Error(`listWorkbenchCapabilities failed: ${res.status}`);
  return res.json();
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
  return res.json();
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
  return res.json();
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
  return res.json();
}

export async function resetBrainConfig(): Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }> {
  const res = await fetch('/api/brain/config/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`resetBrainConfig failed: ${res.status}`);
  return res.json();
}

export async function getBrainConfigFromSession(sessionId: string): Promise<BrainConfigResponse> {
  const res = await fetch(`/api/brain/config/from-session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getBrainConfigFromSession failed: ${res.status}`);
  return res.json();
}
