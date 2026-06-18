/* Workbench API client — talks to backend /ui/workbench/* endpoints */
/* Uses named SSE events (event: text, event: tool_use, etc.) per backend. */

import type {
  WorkbenchSession,
  WorkbenchAgentRegistry,
  WorkbenchCapabilities,
  WorkbenchBtwResult,
  WorkbenchEventHandlers,
} from '@/types/workbench';

export interface CreateWorkbenchSessionParams {
  provider?: 'claude' | 'codex';
  agentId?: string;
}

export async function createWorkbenchSession(
  params: CreateWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  const res = await fetch('/ui/workbench/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: params.provider || 'claude',
      agentId: params.agentId || 'build',
    }),
  });
  if (!res.ok) throw new Error(`createWorkbenchSession failed: ${res.status}`);
  return res.json();
}

export async function getWorkbenchSessions(): Promise<WorkbenchSession[]> {
  const res = await fetch('/ui/workbench/sessions');
  if (!res.ok) throw new Error(`getWorkbenchSessions failed: ${res.status}`);
  const data = await res.json();
  return data.sessions || data || [];
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch(`/ui/workbench/session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getWorkbenchSession failed: ${res.status}`);
  return res.json();
}

export interface StreamWorkbenchChatParams {
  sessionId: string;
  message: string;
  provider?: 'claude' | 'codex';
  agentId?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  model?: string;
}

/**
 * Stream a Workbench chat turn. Parses named SSE events from
 * POST /ui/workbench/chat and dispatches to the provided handlers.
 */
export async function streamWorkbenchChat(
  params: StreamWorkbenchChatParams,
  handlers: WorkbenchEventHandlers,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch('/ui/workbench/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      message: params.message,
      provider: params.provider || 'claude',
      agentId: params.agentId,
      effort: params.effort,
      model: params.model,
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    handlers.onError?.({ message: `Workbench chat failed: ${res.status} ${errText}` });
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    handlers.onDone?.();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
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
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            dispatchWorkbenchEvent(currentEvent, payload, handlers);
          } catch {
            // Ignore non-JSON data lines
          }
        }
      }
      buffer = buffer.slice(lineStart);
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    handlers.onError?.({ message: e?.message || 'Stream read error' });
  }
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
    case 'done':
      handlers.onDone?.();
      break;
    case 'error':
      handlers.onError?.({ message: payload?.message || 'Unknown error' });
      break;
  }
}

export async function approveWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  const res = await fetch('/ui/workbench/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error(`approveWorkbenchPlan failed: ${res.status}`);
  return res.json();
}

export interface ResetWorkbenchSessionParams {
  sessionId?: string;
  provider?: 'claude' | 'codex';
  agentId?: string;
}

export async function resetWorkbenchSession(
  params: ResetWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  const res = await fetch('/ui/workbench/reset', {
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
  const res = await fetch(`/ui/workbench/agents?active=${encodeURIComponent(activeAgentId)}`);
  if (!res.ok) throw new Error(`listWorkbenchAgents failed: ${res.status}`);
  return res.json();
}

export async function listWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  const res = await fetch('/ui/workbench/capabilities');
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
  const res = await fetch('/ui/workbench/btw', {
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
