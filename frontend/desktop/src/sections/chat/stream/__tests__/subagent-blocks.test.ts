/**
 * Durable sub-agent transcript blocks.
 *
 * Pinned here:
 *  * a worker round-trips live container → `subagent` block → live container;
 *  * a duplicate SSE frame replaces the block in place (never appends a
 *    second one) and a settled block is not downgraded by a late replay;
 *  * a transcript rehydrates the store, so a reload / session switch restores
 *    the worker output instead of a status-only stub;
 *  * a live container wins over its stale stored snapshot on reconnect, so
 *    output never rewinds;
 *  * a `subagent` block lands on the message that spawned it.
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage, MessageBlock, SubagentBlockState } from '@/types/chat';
import {
  attachSnapshot,
  collectSnapshots,
  fromSnapshot,
  readSnapshot,
  snapshotsFromMessages,
  snapshotsToState,
  subagentBlockId,
  toSnapshot,
  upsertSnapshotBlock,
} from '../subagent-blocks';

function worker(overrides: Partial<SubagentBlockState> = {}): SubagentBlockState {
  return {
    id: 'sb_job-1',
    jobId: 'job-1',
    parentToolId: 'toolu_spawn',
    agentId: 'research',
    task: 'Audit the memory plan',
    status: 'running',
    startedAt: 1_000,
    blocks: [],
    ...overrides,
  };
}

function assistant(blocks: MessageBlock[] = []): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'done',
    timestamp: '2026-09-24T00:00:00Z',
    blocks,
  };
}

describe('subagent block round trip', () => {
  it('stores a worker as a subagent block and reads it back unchanged', () => {
    const state = worker({
      status: 'completed',
      finishedAt: 2_000,
      blocks: [
        { id: 'b_think_0', type: 'thinking', content: 'reading the plan' },
        { id: 'b_out_0', type: 'finalOutput', content: 'The plan has three gaps.' },
      ],
    });
    const blocks = upsertSnapshotBlock([], state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(subagentBlockId('job-1'));
    expect(blocks[0].type).toBe('subagent');

    const restored = fromSnapshot(readSnapshot(blocks[0])!);
    // The snapshot is the live container minus the derived `id`, which
    // `fromSnapshot` rebuilds from the job id so the restored container keeps
    // working with code that expects a live `SubagentBlockState`.
    expect(restored).toEqual({ id: 'sb_job-1', ...toSnapshot(state) });
    expect(restored.blocks.map((b) => b.type)).toEqual(['thinking', 'finalOutput']);
  });

  it('replaces a block in place rather than appending a duplicate row', () => {
    const first = upsertSnapshotBlock([], worker());
    const second = upsertSnapshotBlock(first, worker({ status: 'completed', finishedAt: 5 }));
    expect(second).toHaveLength(1);
    expect(readSnapshot(second[0])!.status).toBe('completed');
  });

  it('returns the same array for an unchanged snapshot so a duplicate frame costs no re-render', () => {
    const first = upsertSnapshotBlock([], worker({ blocks: [{ id: 'b1', type: 'finalOutput', content: 'hi' }] }));
    const replay = upsertSnapshotBlock(first, worker({ blocks: [{ id: 'b1', type: 'finalOutput', content: 'hi' }] }));
    expect(replay).toBe(first);
  });

  it('does not let a replayed subagentStart re-open a settled worker', () => {
    const settled = upsertSnapshotBlock([], worker({ status: 'completed', finishedAt: 5 }));
    // Reconnect replays the original `subagentStart` — still "running".
    const replayed = upsertSnapshotBlock(settled, worker({ status: 'running', blocks: [] }));
    expect(replayed).toBe(settled);
    expect(readSnapshot(replayed[0])!.status).toBe('completed');
  });

  it('ignores a snapshot block with no job id', () => {
    const blocks: MessageBlock[] = [
      { id: 'b_sub_bad', type: 'subagent', subagent: { agentId: 'x' } as never },
    ];
    expect(readSnapshot(blocks[0])).toBeNull();
    expect(collectSnapshots(blocks)).toEqual([]);
  });
});

describe('rehydration', () => {
  it('restores every worker from a persisted transcript', () => {
    const transcript = [
      assistant([
        upsertSnapshotBlock([], worker({ jobId: 'job-2', startedAt: 2_000 }))[0],
      ]),
      assistant([
        upsertSnapshotBlock([], worker({
          jobId: 'job-1',
          startedAt: 1_000,
          status: 'completed',
          blocks: [{ id: 'b1', type: 'finalOutput', content: 'result' }],
        }))[0],
      ]),
    ];
    const restored = snapshotsFromMessages(transcript);
    expect([...restored.keys()]).toEqual(['job-1', 'job-2']); // spawn order
    expect(restored.get('job-1')!.blocks).toHaveLength(1);
  });

  it('de-duplicates a job that appears in two messages', () => {
    const block = upsertSnapshotBlock([], worker({ blocks: [{ id: 'b1', type: 'finalOutput', content: 'first' }] }))[0];
    const restored = snapshotsFromMessages([assistant([block]), assistant([block])]);
    expect(restored.size).toBe(1);
  });

  it('tolerates a transcript with no worker blocks', () => {
    expect(snapshotsFromMessages(undefined).size).toBe(0);
    expect(snapshotsFromMessages([assistant()]).size).toBe(0);
    expect(snapshotsToState([]).size).toBe(0);
  });
});

describe('attachSnapshot', () => {
  it('lands the block on the message whose tool call spawned the worker', () => {
    const spawnMsg = assistant([
      { id: 'b_tool_toolu_spawn', type: 'toolCall', tool: { id: 'toolu_spawn', name: 'august__spawn_subagent', status: 'done' } },
    ]);
    const laterMsg = assistant([{ id: 'b_out_0', type: 'finalOutput', content: 'the answer' }]);
    const out = attachSnapshot([spawnMsg, laterMsg], worker());
    expect(collectSnapshots(out[0].blocks).map((s) => s.jobId)).toEqual(['job-1']);
    expect(out[1].blocks).toHaveLength(1); // untouched
  });

  it('falls back to the last assistant message when no tool call claims it', () => {
    const bare = { ...assistant(), blocks: undefined };
    const out = attachSnapshot([bare, assistant()], worker());
    expect(out[0].blocks).toBeUndefined();
    expect(collectSnapshots(out[1].blocks).map((s) => s.jobId)).toEqual(['job-1']);
  });

  it('updates the existing block on a second write instead of adding one', () => {
    const withBlock = attachSnapshot([assistant()], worker());
    const updated = attachSnapshot(withBlock, worker({ status: 'completed', finishedAt: 9 }));
    expect(updated[0].blocks).toHaveLength(1);
    expect(readSnapshot(updated[0].blocks![0])!.status).toBe('completed');
  });

  it('returns the same array when the snapshot is unchanged', () => {
    const once = attachSnapshot([assistant()], worker());
    const twice = attachSnapshot(once, worker());
    expect(twice).toBe(once);
  });

  it('is a no-op on an empty transcript', () => {
    const empty: ChatMessage[] = [];
    expect(attachSnapshot(empty, worker())).toBe(empty);
  });
});
