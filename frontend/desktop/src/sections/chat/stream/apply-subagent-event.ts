/**
 * Applies backend sub-agent SSE events to the session's `subagentBlocks` map.
 * Used by the durable per-session subscriber and by the per-turn reducer when
 * nested agents stream under a parent tool call. Events without `jobId` are
 * no-ops. Mutates via appendBlockEvent so nested blocks share parent merge rules.
 *
 * Every mutation is ALSO mirrored onto a `subagent` block of the parent
 * assistant message (see subagent-blocks.ts). That mirror is what makes the
 * worker's transcript durable: the `subagentBlocks` map is in-memory only, so
 * without it a reload or session switch leaves the inline row with a status
 * and no output. The mirror rides the existing persistence paths — localStorage
 * and the structured-block sync — so no new transport is introduced.
 */

import {
  updateSessionStreamState,
  useSessionStreamStore,
} from './session-stream-store';
import { appendBlockEvent } from './append-block-event';
import { attachSnapshot } from './subagent-blocks';
import { persistMessagesDebounced } from './session-stream-store';
import { scheduleTranscriptSync } from './transcript-sync';
import type { AppendBlockEvent, SubagentBlockState } from '@/types/chat';

export type SubagentStreamEvent =
  | { type: 'subagentStart'; jobId: string; agentId: string; parentToolUseId?: string; scope?: string; task?: string; goal?: string; depth?: number; workstream?: string; skills?: string[] }
  | { type: 'subagentText'; jobId: string; content?: string }
  | { type: 'subagentRetry'; jobId: string; attempt?: number; maxRetries?: number; message?: string }
  | { type: 'subagentWarning'; jobId: string; message?: string }
  | { type: 'subagentToolCall'; jobId: string; id: string; name: string; input?: Record<string, unknown>; context?: string; status?: 'running' | 'done' | 'error' }
  | { type: 'subagentToolResult'; jobId: string; id: string; content?: unknown; isError?: boolean; status?: 'done' | 'error' | 'running'; summary?: string; error?: string; duration?: number }
  | { type: 'subagentDone'; jobId: string; agentId?: string; status?: 'completed' | 'failed' | 'cancelled' | 'error' | 'blocked' | 'partial' | 'recovered' | 'skipped'; message?: string; result?: string; workstream?: string };

/** The inner-block event one SSE frame contributes to a worker's timeline.
 *
 *  This is the SINGLE mapping from the backend's `subagent*` vocabulary to the
 *  block vocabulary `appendBlockEvent` speaks. The right-drawer transcript
 *  replay feeds the same jsonl events through here, so the live stream and the
 *  reload cannot drift into two different vocabularies again — the drawer used
 *  to filter on `text`/`toolCall`/`finalOutput` against a transcript that only
 *  ever contained `subagentText`/`subagentToolCall`/`subagentDone`, which made
 *  every replay render nothing.
 *
 *  Lifecycle frames (`subagentStart`, `subagentRunning`) carry no output and
 *  return null. */
export function subagentEventToBlockEvent(
  event: SubagentStreamEvent,
): AppendBlockEvent | null {
  switch (event.type) {
    case 'subagentText':
      return { type: 'text', content: event.content || '' };
    case 'subagentRetry':
      // Transient upstream error — the worker is backing off and will retry.
      return {
        type: 'text',
        content: `↻ retrying (${event.attempt}/${event.maxRetries ?? '?'}) — ${event.message || 'transient upstream error'}`,
      };
    case 'subagentWarning':
      // The live stream routes warnings to a parent-level `onWarning` notice
      // instead (see streamEvents), but the persisted transcript carries them as
      // worker frames — so a drawer replay used to show a stall nudge or a
      // narrated-tool-call warning as nothing at all.
      return { type: 'text', content: `⚠ ${event.message || 'worker warning'}` };
    case 'subagentToolCall': {
      const context = event.context
        || (event.input && Object.keys(event.input).length > 0
          ? JSON.stringify(event.input, null, 2)
          : '');
      return {
        type: 'toolCall',
        id: event.id,
        name: event.name,
        context,
        status: event.status || 'running',
      };
    }
    case 'subagentToolResult': {
      const resultStr = typeof event.content === 'string'
        ? event.content
        : event.content != null ? JSON.stringify(event.content) : '';
      return {
        type: 'toolResult',
        id: event.id,
        status: event.status || (event.isError ? 'error' : 'done'),
        summary: event.summary || resultStr.slice(0, 240),
        error: event.error || (event.isError ? resultStr.slice(0, 240) : ''),
        duration: event.duration,
      };
    }
    case 'subagentDone': {
      const text = subagentResultText(event.result).trim();
      return text ? { type: 'finalOutput', content: text } : null;
    }
    default:
      return null;
  }
}

/** Defensive coercion: the backend is supposed to send a string, but a dict
 *  payload here used to throw on `.trim()` and the SSE reader swallowed the
 *  error — silently dropping `subagentDone` forever and leaving the chat
 *  container stuck at "running". */
export function subagentResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const nested = (raw as Record<string, unknown>).result
      ?? (raw as Record<string, unknown>).output;
    if (typeof nested === 'string') return nested;
    return nested != null ? JSON.stringify(nested) : '';
  }
  return '';
}

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
        skills: event.skills,
        status: 'running',
        startedAt: Date.now(),
        blocks: [],
      });
      mutated = true;
      return { subagentBlocks: blocks };
    });
    mirrorToTranscript(sessionId, jobId, mutated);
    return mutated;
  }

  if (event.type === 'subagentDone') {
    updateSessionStreamState(sessionId, (prev) => {
      const blocks = new Map(prev.subagentBlocks);
      // A settled frame with no container used to be discarded, which is how a
      // reload, an LRU eviction or a lane the parent skipped turned "the worker
      // finished" into "the worker never existed". Rebuild the row from what the
      // frame itself carries instead: it names its jobId, its status and its
      // result, which is everything a truthful row needs.
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
      const resultText = subagentResultText(event.result).trim();
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
    mirrorToTranscript(sessionId, jobId, mutated);
    return mutated;
  }

  // For text/toolCall/toolResult/retry/warning events, mutate the inner
  // blocks array via appendBlockEvent (same reducer as the parent).
  updateSessionStreamState(sessionId, (prev) => {
    const blocks = new Map(prev.subagentBlocks);
    const innerEvent = subagentEventToBlockEvent(event);
    if (!innerEvent) return {};
    const current = blocks.get(jobId);
    if (!current) return {};
    blocks.set(jobId, {
      ...current,
      blocks: appendBlockEvent(current.blocks, innerEvent),
    });
    mutated = true;
    return { subagentBlocks: blocks };
  });
  mirrorToTranscript(sessionId, jobId, mutated);
  return mutated;
}

/**
 * Copy the just-mutated worker onto its parent message's `subagent` block and
 * queue the two durable writes.
 *
 * Both writes are debounced and fire-and-forget, matching the rest of the
 * streaming path: a chatty worker (a text frame per token) must not turn into
 * a localStorage write and an HTTP request per token. `scheduleTranscriptSync`
 * is the same debounce the send path uses, so the backend converges on the
 * latest transcript rather than an intermediate one.
 */
function mirrorToTranscript(sessionId: string, jobId: string, mutated: boolean): void {
  if (!mutated) return;
  const state = useSessionStreamStore.getState().bySession[sessionId];
  const container: SubagentBlockState | undefined = state?.subagentBlocks.get(jobId);
  // An event for a job with no live container (a late duplicate frame after
  // the container was dropped) must not resurrect a row.
  if (!container) return;

  updateSessionStreamState(
    sessionId,
    (prev) => {
      const messages = attachSnapshot(prev.messages, container);
      if (messages === prev.messages) return {};
      return { messages };
    },
    // A live reducer, NOT a transcript replacement: claiming the messages
    // array as a new snapshot would cancel a history fetch in flight and
    // make the session look "ready" while its backend half is still loading.
    { transcriptUpdate: 'stream' },
  );

  const messages = useSessionStreamStore.getState().bySession[sessionId]?.messages;
  if (!messages) return;
  persistMessagesDebounced(sessionId, messages);
  scheduleTranscriptSync(sessionId, messages);
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
    skills?: string[];
  }) => void;
      onSubagentDone: (data: {
        jobId?: string;
        agentId?: string;
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
        skills: data.skills,
      });
    },
    onSubagentDone: (data) => {
      if (!data?.jobId) return;
      applySubagentEvent(sessionId, {
        type: 'subagentDone',
        jobId: data.jobId,
        agentId: data.agentId,
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
