/**
 * The durable half of the sub-agent SSE path.
 *
 * `apply-subagent-event.test`-style coverage elsewhere pins the in-memory
 * reducer; what matters here is that every event ALSO lands on the parent
 * assistant message as a `subagent` block, and that a reconnect merges the
 * restored transcript with whatever is already live.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/types/chat';

const scheduleTranscriptSync = vi.hoisted(() => vi.fn());

vi.mock('../transcript-sync', () => ({
  scheduleTranscriptSync,
  flushTranscriptSync: vi.fn(),
  resetTranscriptSync: vi.fn(),
}));

import { applySubagentEvent } from '../apply-subagent-event';
import {
  evictSessionStreamState,
  updateSessionStreamState,
  useSessionStreamStore,
} from '../session-stream-store';
import { readSnapshot, collectSnapshots } from '../subagent-blocks';

const SESSION = 'sess-sub-durable';

function seed(blocks: ChatMessage['blocks'] = []): void {
  updateSessionStreamState(
    SESSION,
    () => ({
      messages: [
        { id: 'm1', role: 'user', content: 'go', timestamp: '2026-09-24T00:00:00Z' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          timestamp: '2026-09-24T00:00:01Z',
          blocks,
        },
      ],
      history: { status: 'ready' },
    }),
    { transcriptUpdate: 'stream' },
  );
}

function assistantBlocks(): ChatMessage['blocks'] {
  return useSessionStreamStore.getState().bySession[SESSION]?.messages.find(
    (m) => m.id === 'a1',
  )?.blocks;
}

beforeEach(() => {
  scheduleTranscriptSync.mockClear();
  evictSessionStreamState(SESSION);
});

afterEach(() => {
  evictSessionStreamState(SESSION);
  vi.restoreAllMocks();
});

describe('applySubagentEvent durability', () => {
  it('mirrors a started worker onto the parent message as a subagent block', () => {
    seed();
    applySubagentEvent(SESSION, {
      type: 'subagentStart',
      jobId: 'job-1',
      agentId: 'research',
      parentToolUseId: 'toolu_spawn',
      task: 'Audit the plan',
    });

    const snapshots = collectSnapshots(assistantBlocks());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      jobId: 'job-1',
      agentId: 'research',
      parentToolId: 'toolu_spawn',
      task: 'Audit the plan',
      status: 'running',
    });
    // The durable write is queued, not awaited — a subagent event must never
    // block the SSE reader.
    expect(scheduleTranscriptSync).toHaveBeenCalledWith(SESSION, expect.any(Array));
  });

  it('keeps one block per job as the worker streams text and tools', () => {
    seed();
    applySubagentEvent(SESSION, { type: 'subagentStart', jobId: 'job-1', agentId: 'research' });
    applySubagentEvent(SESSION, { type: 'subagentText', jobId: 'job-1', content: 'reading' });
    applySubagentEvent(SESSION, { type: 'subagentText', jobId: 'job-1', content: ' files' });
    applySubagentEvent(SESSION, {
      type: 'subagentToolCall',
      jobId: 'job-1',
      id: 't1',
      name: 'read_file',
    });
    applySubagentEvent(SESSION, {
      type: 'subagentToolResult',
      jobId: 'job-1',
      id: 't1',
      content: 'ok',
    });

    const snapshots = collectSnapshots(assistantBlocks());
    expect(snapshots).toHaveLength(1);
    const types = snapshots[0].blocks.map((b) => b.type);
    // Coalesced into ONE text block, plus the tool — not a block per frame.
    expect(types.filter((t) => t === 'finalOutput')).toHaveLength(1);
    expect(readSnapshot(assistantBlocks()![0])!.blocks[0].content).toBe('reading files');
  });

  it('persists the final result on subagentDone', () => {
    seed();
    applySubagentEvent(SESSION, { type: 'subagentStart', jobId: 'job-1', agentId: 'research' });
    applySubagentEvent(SESSION, {
      type: 'subagentDone',
      jobId: 'job-1',
      status: 'partial',
      result: 'Found two gaps before the cap hit.',
    });

    const snapshot = collectSnapshots(assistantBlocks())[0];
    expect(snapshot.status).toBe('partial');
    expect(snapshot.finishedAt).toBeGreaterThan(0);
    expect(snapshot.blocks.at(-1)!.content).toContain('two gaps');
  });

  it('does not double-append the result when text already streamed it', () => {
    seed();
    applySubagentEvent(SESSION, { type: 'subagentStart', jobId: 'job-1', agentId: 'research' });
    applySubagentEvent(SESSION, { type: 'subagentText', jobId: 'job-1', content: 'Final answer.' });
    applySubagentEvent(SESSION, {
      type: 'subagentDone',
      jobId: 'job-1',
      status: 'completed',
      result: 'Final answer.',
    });

    const finals = collectSnapshots(assistantBlocks())[0].blocks.filter(
      (b) => b.type === 'finalOutput',
    );
    expect(finals).toHaveLength(1);
    expect(finals[0].content).toBe('Final answer.');
  });

  it('a duplicate subagentStart leaves one block and does not reset it', () => {
    seed();
    applySubagentEvent(SESSION, { type: 'subagentStart', jobId: 'job-1', agentId: 'research' });
    applySubagentEvent(SESSION, { type: 'subagentText', jobId: 'job-1', content: 'working' });
    const mutated = applySubagentEvent(SESSION, {
      type: 'subagentStart',
      jobId: 'job-1',
      agentId: 'research',
    });

    expect(mutated).toBe(false);
    const snapshots = collectSnapshots(assistantBlocks());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].blocks[0].content).toBe('working');
  });

  it('ignores an event for a job with no container instead of resurrecting it', () => {
    seed();
    const mutated = applySubagentEvent(SESSION, {
      type: 'subagentText',
      jobId: 'never-started',
      content: 'ghost',
    });
    expect(mutated).toBe(false);
    expect(collectSnapshots(assistantBlocks())).toHaveLength(0);
  });

  it('keeps history loading so a mid-load event cannot claim the transcript', () => {
    updateSessionStreamState(
      SESSION,
      () => ({
        messages: [{ id: 'a1', role: 'assistant', content: '', timestamp: 'x', blocks: [] }],
        history: { status: 'loading' },
      }),
      { transcriptUpdate: 'stream' },
    );
    applySubagentEvent(SESSION, { type: 'subagentStart', jobId: 'job-1', agentId: 'research' });

    const state = useSessionStreamStore.getState().bySession[SESSION];
    expect(state?.history?.status).toBe('loading');
    expect(collectSnapshots(state?.messages[0].blocks)).toHaveLength(1);
  });
});
