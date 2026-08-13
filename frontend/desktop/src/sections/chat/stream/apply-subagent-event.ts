/**
 * Applies backend sub-agent SSE events to the session's `subagentBlocks` map.
 * Used by the durable per-session subscriber and by the per-turn reducer when
 * nested agents stream under a parent tool call. Events without `jobId` are
 * no-ops. Mutates via appendBlockEvent so nested blocks share parent merge rules.
 */

import { updateSessionStreamState } from './session-stream-store';
import { appendBlockEvent } from './append-block-event';

export type SubagentStreamEvent =
  | { type: 'subagentStart'; jobId: string; agentId: string; parentToolUseId?: string; scope?: string; task?: string; goal?: string; depth?: number; workstream?: string }
  | { type: 'subagentText'; jobId: string; content?: string }
  | { type: 'subagentRetry'; jobId: string; attempt?: number; maxRetries?: number; message?: string }
  | { type: 'subagentToolCall'; jobId: string; id: string; name: string; input?: Record<string, unknown>; context?: string; status?: 'running' | 'done' | 'error' }
  | { type: 'subagentToolResult'; jobId: string; id: string; content?: unknown; isError?: boolean; status?: 'done' | 'error' | 'running'; summary?: string; error?: string; duration?: number }
  | { type: 'subagentDone'; jobId: string; status?: 'completed' | 'failed' | 'cancelled' | 'error' | 'blocked' | 'partial' | 'recovered' | 'skipped'; message?: string; result?: string; workstream?: string };

/**
 * Returns `true` when the event mutated state so callers can decide
 * whether to trigger a re-render.
 */
export function applySubagentEvent(
  sessionId: string,
  event: SubagentStreamEvent,
): boolean {
  if (!sessionId || !event?.jobId) return false;
  const jobId = event.jobId;
  let mutated = false;

  if (event.type === 'subagentStart') {
    updateSessionStreamState(sessionId, (prev) => {
      const blocks = new Map(prev.subagentBlocks);
      if (blocks.has(jobId)) return {};
      const task =
        event.task ||
        (event as { goal?: string }).goal ||
        undefined;
      blocks.set(jobId, {
        id: `sb_${jobId}`,
        jobId,
        parentToolId: event.parentToolUseId || `subagent-${jobId}`,
        agentId: event.agentId,
        scope: event.scope,
        task,
        depth: event.depth,
        workstream: event.workstream,
        status: 'running',
        startedAt: Date.now(),
        blocks: [],
      });
      mutated = true;
      return { subagentBlocks: blocks };
    });
    return mutated;
  }

  if (event.type === 'subagentDone') {
    updateSessionStreamState(sessionId, (prev) => {
      const blocks = new Map(prev.subagentBlocks);
      const current = blocks.get(jobId);
      if (!current) return {};
      // Backend statuses pass through: error/blocked/partial/recovered must
      // not masquerade as completed (they used to be coerced to 'completed',
      // hiding failures).
      const status = event.status === 'failed' || event.status === 'error' || event.status === 'blocked'
        ? 'failed'
        : event.status === 'cancelled' || event.status === 'skipped' ? 'cancelled'
        : event.status === 'partial' ? 'partial'
        : event.status === 'recovered' ? 'completed'
        : 'completed';
      let inner = current.blocks;
      // Defensive coercion: the backend is supposed to send a string, but a
      // dict payload here used to throw on .trim() and the SSE reader
      // swallowed the error — silently dropping subagentDone forever.
      const raw = event.result as unknown;
      let resultRaw = '';
      if (typeof raw === 'string') {
        resultRaw = raw;
      } else if (raw && typeof raw === 'object') {
        const nested = (raw as Record<string, unknown>).result
          ?? (raw as Record<string, unknown>).output;
        resultRaw = typeof nested === 'string'
          ? nested
          : nested != null ? JSON.stringify(nested) : '';
      }
      const resultText = resultRaw.trim();
      if (resultText) {
        const hasFinal = inner.some(
          (b) => b.type === 'finalOutput' && (b.content || '').trim(),
        );
        if (!hasFinal) {
          inner = appendBlockEvent(inner, {
            type: 'finalOutput',
            content: resultText,
          });
        }
      }
      blocks.set(jobId, {
        ...current,
        blocks: inner,
        status,
        finishedAt: Date.now(),
        error: event.message,
      });
      mutated = true;
      return { subagentBlocks: blocks };
    });
    return mutated;
  }

  // For text/toolCall/toolResult events, mutate the inner
  // blocks array via appendBlockEvent (same reducer as the parent).
  updateSessionStreamState(sessionId, (prev) => {
    const blocks = new Map(prev.subagentBlocks);
    const current = blocks.get(jobId);
    if (!current) return {};
    if (event.type === 'subagentText') {
      const inner = appendBlockEvent(current.blocks, { type: 'text', content: event.content || '' });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagentRetry') {
      // Transient upstream error — the worker is backing off and will retry.
      const inner = appendBlockEvent(current.blocks, {
        type: 'text',
        content: `↻ retrying (${event.attempt}/${event.maxRetries ?? '?'}) — ${event.message || 'transient upstream error'}`,
      });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagentToolCall') {
      const context = event.context
        || (event.input && Object.keys(event.input).length > 0
          ? JSON.stringify(event.input, null, 2)
          : '');
      const inner = appendBlockEvent(current.blocks, {
        type: 'toolCall',
        id: event.id,
        name: event.name,
        context,
        status: event.status || 'running',
      });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    } else if (event.type === 'subagentToolResult') {
      const resultStr = typeof event.content === 'string'
        ? event.content
        : event.content != null ? JSON.stringify(event.content) : '';
      const inner = appendBlockEvent(current.blocks, {
        type: 'toolResult',
        id: event.id,
        status: (event.status || (event.isError ? 'error' : 'done')),
        summary: event.summary || resultStr.slice(0, 240),
        error: event.error || (event.isError ? resultStr.slice(0, 240) : ''),
        duration: event.duration,
      });
      blocks.set(jobId, { ...current, blocks: inner });
      mutated = true;
    }
    return { subagentBlocks: blocks };
  });
  return mutated;
}

/** WorkbenchEventHandlers slice that routes nested-agent SSE into subagentBlocks. */
export function makeSubagentEventHandlers(sessionId: string): {
  onSubagentStart: (data: {
    jobId?: string;
    agentId: string;
    parentToolUseId?: string;
    scope?: string;
        task?: string;
        goal?: string;
        depth?: number;
        workstream?: string;
      }) => void;
      onSubagentDone: (data: {
        jobId?: string;
        status?: 'completed' | 'failed' | 'cancelled' | 'error' | 'blocked' | 'partial' | 'recovered' | 'skipped';
        message?: string;
        result?: string;
        workstream?: string;
      }) => void;
  onSubagentText: (data: { jobId?: string; content?: string }) => void;
  onSubagentToolCall: (data: {
    jobId?: string;
    id: string;
    name: string;
    input?: Record<string, unknown>;
    status?: 'running' | 'done' | 'error';
  }) => void;
  onSubagentToolResult: (data: {
    jobId?: string;
    id: string;
    content?: unknown;
    isError?: boolean;
    status?: 'done' | 'error' | 'running';
  }) => void;
  onSubagentRetry: (data: {
    jobId?: string;
    attempt?: number;
    maxRetries?: number;
    message?: string;
  }) => void;
} {
  return {
    onSubagentStart: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentStart',
        jobId: data.jobId,
        agentId: data.agentId,
        parentToolUseId: data.parentToolUseId,
        scope: data.scope,
        task: data.task,
        goal: data.goal,
        depth: data.depth,
        workstream: data.workstream,
      });
    },
    onSubagentDone: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentDone',
        jobId: data.jobId,
        status: data.status,
        message: data.message,
        result: data.result,
        workstream: data.workstream,
      });
    },
    onSubagentText: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentText',
        jobId: data.jobId,
        content: data.content || '',
      });
    },
    onSubagentToolCall: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentToolCall',
        jobId: data.jobId,
        id: data.id,
        name: data.name,
        input: data.input,
        status: data.status || 'running',
      });
    },
    onSubagentToolResult: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentToolResult',
        jobId: data.jobId,
        id: data.id,
        content: data.content,
        isError: data.isError,
        status: data.status || (data.isError ? 'error' : 'done'),
      });
    },
    onSubagentRetry: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentRetry',
        jobId: data.jobId,
        attempt: data.attempt,
        maxRetries: data.maxRetries,
        message: data.message,
      });
    },
  };
}
