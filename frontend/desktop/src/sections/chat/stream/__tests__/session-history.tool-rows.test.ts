/* ── mapRemoteMessages: no duplicated tool rows ──────────────────────────
 *
 * Since migration 047 a turn's tool activity lives in the ASSISTANT message's
 * `blocks`, which is what the transcript timeline renders (collapsed under
 * "Task completed · N steps", with real tool names). The transcript also still
 * carries the pre-047 shape: one standalone `role:'tool'` row per result, with
 * its own `tool` payload. Restoring both rendered every call twice.
 *
 * Measured on a real session: 30 standalone tool rows, all 30 sharing their
 * `toolUseId` with an assistant block id. The duplicate bubbles were also
 * unlabelled, because an Anthropic tool_result carries `tool_use_id` but no
 * `name`, so each fell back to the one generic "Executing Tool" string.
 *
 * The legacy shape must still work: a transcript whose assistant messages carry
 * no blocks keeps its tool rows, because there the row is the only rendering. */

import { describe, it, expect } from 'vitest';
import { mapRemoteMessages, reconcileHistory } from '../session-history';

const assistantWithBlocks = {
  id: 2,
  role: 'assistant',
  content: 'Working on it.',
  blocks: [
    { id: 'call_a', type: 'toolCall', tool: { id: 'call_a', name: 'read_file', status: 'done' } },
    { id: 'call_b', type: 'toolCall', tool: { id: 'call_b', name: 'run_command', status: 'done' } },
  ],
};
const toolRowA = {
  id: 3,
  role: 'tool',
  content: 'file body',
  toolUseId: 'call_a',
  tool: { id: 'call_a', name: '', status: 'done', result: 'file body' },
};
const toolRowB = {
  id: 4,
  role: 'tool',
  content: 'exit 0',
  toolUseId: 'call_b',
  tool: { id: 'call_b', name: '', status: 'done', result: 'exit 0' },
};

describe('mapRemoteMessages — tool rows already rendered by an assistant block', () => {
  it('drops the standalone row for a tool the assistant block already renders', () => {
    const out = mapRemoteMessages([assistantWithBlocks, toolRowA, toolRowB]);
    // The assistant message survives with its blocks intact...
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    expect(out[0].blocks).toHaveLength(2);
    // ...and no unlabelled 'tool' bubble is produced for the same calls.
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('MERGES the row result into the block instead of discarding it', () => {
    // The block carries the NAME and the row carries the OUTCOME. Dropping the
    // row without merging lost 26,195 characters of tool output on one real
    // session and left every tool stuck at status 'running' — i.e. a permanent
    // spinner with nothing in it, because ToolStepRow treats 'running' as
    // expanded + animating.
    const out = mapRemoteMessages([assistantWithBlocks, toolRowA, toolRowB]);
    const blocks = out[0].blocks as unknown as Array<{ id: string; tool: Record<string, unknown> }>;
    const a = blocks.find((b) => b.id === 'call_a')!;
    const b = blocks.find((x) => x.id === 'call_b')!;

    // Outcome merged in.
    expect(a.tool.status).toBe('done');
    expect(a.tool.result).toBe('file body');
    // Name kept from the block (the row's name is empty for Anthropic rows).
    expect(a.tool.name).toBe('read_file');
    expect(b.tool.name).toBe('run_command');
    expect(b.tool.result).toBe('exit 0');
    // Nothing may be left claiming to still be running.
    expect(blocks.some((x) => x.tool.status === 'running')).toBe(false);
  });

  it('carries toolUseId through STRUCTURED_FIELDS onto the ChatMessage', () => {
    // Without this, `mapRemoteMessages` produces a ChatMessage with no join key,
    // `persistMessages` writes it, and the cache-side merge can never pair a row
    // with its block — silently, and with every other test still green. The
    // other tests in this file read the RAW wire row, so they cannot see it.
    const out = mapRemoteMessages([assistantWithBlocks, toolRowA, toolRowB]);
    expect(out[0].blocks).toHaveLength(2);
    // The assistant keeps its blocks and carries no row identity.
    expect(out[0].toolUseId).toBeUndefined();
    // A row that survives the mapping (no assistant block renders it) must keep
    // the id — that is the field the persisted cache is joined on.
    const orphan = mapRemoteMessages([
      { id: 9, role: 'tool', content: 'x', toolUseId: 'call_z', tool: { id: 'call_z', name: '', status: 'done' } },
    ]);
    expect(orphan[0].toolUseId).toBe('call_z');
  });

  it('does not resurrect a running block that has no result row', () => {
    // A tool the transcript never recorded a result for stays 'running' — that
    // is the truth, and the merge must not invent a completion.
    const out = mapRemoteMessages([
      {
        id: 2,
        role: 'assistant',
        content: 'Working.',
        blocks: [
          { id: 'call_p', type: 'toolCall', tool: { id: 'call_p', name: 'read_file', status: 'running' } },
        ],
      },
    ]);
    const blocks = out[0].blocks as unknown as Array<{ id: string; tool: Record<string, unknown> }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool.status).toBe('running');
  });

  it('keeps tool rows for a legacy transcript whose assistant has no blocks', () => {
    const legacy = [
      { id: 1, role: 'user', content: 'do it' },
      { id: 2, role: 'assistant', content: 'on it' },
      { id: 3, role: 'tool', content: 'exit 0', toolUseId: 'call_x', tool: { id: 'call_x', name: '', status: 'done' } },
    ];
    const out = mapRemoteMessages(legacy);
    // Nothing is lost: the row is the only rendering of that call here.
    expect(out).toHaveLength(3);
    expect(out.some((m) => m.role === 'tool')).toBe(true);
  });

  it('drops only the duplicated row, never the one with no assistant block', () => {
    const out = mapRemoteMessages([
      assistantWithBlocks,
      toolRowA, // duplicated — dropped
      { id: 9, role: 'tool', content: 'orphan', toolUseId: 'call_zzz', tool: { id: 'call_zzz', name: '', status: 'done' } },
    ]);
    expect(out).toHaveLength(2);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(out.find((m) => m.role === 'tool')?.content).toBe('orphan');
  });

  it('does not drop a row that merely shares a role with a block-bearing message', () => {
    const out = mapRemoteMessages([
      { id: 1, role: 'assistant', content: 'hi', blocks: [{ id: 'call_a', type: 'toolCall', tool: { id: 'call_a', name: 'read_file' } }] },
      { id: 2, role: 'tool', content: 'kept', toolUseId: 'call_other', tool: { id: 'call_other', name: '', status: 'done' } },
    ]);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

/* The second half of the same bug. `mapRemoteMessages` dropping the rows is
 * only half: the client's cached copy still held them, and the merge pushed
 * anything it could not match back into the transcript, so they came straight
 * back on every load. `ensureSessionHistory` is what calls the merge; this
 * pins the rule it now follows. */
describe('reconcileHistory — the client cache cannot resurrect a removed row', () => {
  const restoredToolRow = {
    id: '147363',
    role: 'tool' as const,
    content: 'exit 0',
    timestamp: '2026-10-10T16:11:33Z',
    remote: true,
  };

  it('drops a cached row the server no longer returns', () => {
    // The assistant message survives the restore; its blocks still render the
    // tool. The cached standalone row must not be pushed back.
    const remote = [
      { id: '1', role: 'user' as const, content: 'go', timestamp: 't', remote: true },
      { id: '2', role: 'assistant' as const, content: 'done', timestamp: 't', remote: true },
    ];
    const out = reconcileHistory(remote, [restoredToolRow]);
    expect(out.map((m) => m.id)).toEqual(['1', '2']);
    expect(out.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps a locally-authored message the server has not persisted yet', () => {
    const remote = [{ id: '1', role: 'user' as const, content: 'go', timestamp: 't', remote: true }];
    const local = { id: 'local-1', role: 'user' as const, content: 'typing…', timestamp: 't' };
    const out = reconcileHistory(remote, [local]);
    expect(out.map((m) => m.id)).toEqual(['1', 'local-1']);
  });

  it('still lets a queued prompt be matched back onto its server row', () => {
    // The queued path replaces the server row rather than appending, which is
    // the behaviour the `continue` above must not break.
    const remote = [
      { id: '1', role: 'user' as const, content: 'go', timestamp: '2026-10-10T16:11:33Z', remote: true },
    ];
    const queued = {
      id: 'client-9',
      role: 'user' as const,
      content: 'go',
      timestamp: '2026-10-10T16:11:33Z',
      queued: true,
    };
    const out = reconcileHistory(remote, [queued]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('client-9');
  });
});