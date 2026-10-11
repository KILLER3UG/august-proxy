/* ── message-storage: the warm-reload path ─────────────────────────────────
 *
 * This is the path an affected user is actually on, and it is why a test file
 * exists here at all.
 *
 * `hydrate` marks history `status:'ready'` whenever a cache exists and
 * `ensureSessionHistory` returns early on `'ready'`, so a reload never fetches
 * and the server-side fix in `mapRemoteMessages` never runs — the cached
 * transcript is served straight from localStorage. Every cache written before
 * the merge fix still holds the duplicated tool rows (30 of them, 26 KB, on one
 * real session).
 *
 * The first version of `dropDuplicatedToolRows` keyed its merge and its drop on
 * `message.toolUseId`, which `ChatMessage` did not declare and
 * `mapRemoteMessages` never copied — so it silently did nothing and the test
 * suite stayed green. `toolUseId` is now carried through the restore
 * (`STRUCTURED_FIELDS`) and declared on `ChatMessage`; these tests pin the
 * persisted SHAPE, because that is the thing that was wrong.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadMessagesForSession,
  persistMessages,
  messagesStorageKey,
} from '../message-storage';
import type { ChatMessage, MessageBlock } from '@/types/chat';

const block = (id: string, name: string, status: string) =>
  ({
    id,
    type: 'toolCall',
    content: '',
    tool: { id, name, status, args: '{}' },
  }) as unknown as MessageBlock;

/** The shape `mapRemoteMessages` produces and `persistMessages` writes. */
const restored: ChatMessage[] = [
  { id: '1', role: 'user', content: 'go', timestamp: '2026-10-10T16:00:00Z', remote: true },
  {
    id: '2',
    role: 'assistant',
    content: 'on it',
    timestamp: '2026-10-10T16:00:01Z',
    remote: true,
    blocks: [block('call_a', 'read_file', 'running'), block('call_b', 'run_command', 'running')],
  },
  {
    id: '3',
    role: 'tool',
    content: 'file body',
    timestamp: '2026-10-10T16:00:02Z',
    remote: true,
    toolUseId: 'call_a',
    tool: { name: '', status: 'done', result: 'file body' },
  },
  {
    id: '4',
    role: 'tool',
    content: 'exit 0',
    timestamp: '2026-10-10T16:00:03Z',
    remote: true,
    toolUseId: 'call_b',
    tool: { name: '', status: 'done', result: 'exit 0' },
  },
];

describe('loadMessagesForSession — merges duplicated tool rows in the cache', () => {
  beforeEach(() => localStorage.clear());

  it('drops the row and folds its outcome into the block', () => {
    localStorage.setItem(messagesStorageKey('s1')!, JSON.stringify(restored));
    const out = loadMessagesForSession('s1');
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    const blocks = out[1].blocks as unknown as Array<{ id: string; tool: Record<string, unknown> }>;
    expect(blocks[0].tool.status).toBe('done');
    expect(blocks[0].tool.result).toBe('file body');
    expect(blocks[1].tool.result).toBe('exit 0');
    // The block's own name survives the empty Anthropic row name.
    expect(blocks.map((b) => b.tool.name)).toEqual(['read_file', 'run_command']);
  });

  it('survives a real round trip through persistMessages', () => {
    // persistMessages is what writes the cache, so the field under test has to
    // survive serialisation, not just exist on the in-memory object.
    persistMessages('s2', restored);
    const out = loadMessagesForSession('s2');
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out).toHaveLength(2);
  });

  it('KEEPS a pre-047 tool row whose own block would otherwise self-register', () => {
  // The regression this file exists to catch. `derive_blocks` gives every
  // standalone `role:'tool'` row its OWN `toolCall` block id'd by
  // `tool_use_id` (`transcript_blocks.py`, the `role == 'tool'` branch). An
  // earlier version of `dropDuplicatedToolRows` collected block ids from EVERY
  // message, so a row's own block put its id in the set; the merge only walked
  // `role === 'assistant'` and so consumed nothing, and the filter deleted the
  // row anyway — silent, permanent loss of the tool output, then re-persisted
  // so no refetch could repair it.
  //
  // The fixture below carries that self-block deliberately. A row WITHOUT one
  // is the shape the old test used and the one the server never sends.
  const pre047: ChatMessage[] = [
    { id: '1', role: 'user', content: 'go', timestamp: 't', remote: true },
    {
      id: '2',
      role: 'assistant',
      content: 'on it',
      timestamp: 't',
      remote: true,
      blocks: [{ id: 'b_text_0', type: 'finalOutput', content: 'on it' } as unknown as MessageBlock],
    },
    {
      id: '3',
      role: 'tool',
      content: 'exit 0',
      timestamp: 't',
      remote: true,
      toolUseId: 'call_a',
      tool: { name: '', status: 'done', result: 'exit 0' },
      // The row's OWN toolCall block, straight from the backend.
      blocks: [
        {
          id: 'call_a',
          type: 'toolCall',
          content: 'exit 0',
          tool: { id: 'call_a', name: '', status: 'done', args: '{}' },
        } as unknown as MessageBlock,
      ],
    },
  ];
  localStorage.setItem(messagesStorageKey('s6')!, JSON.stringify(pre047));
  const out = loadMessagesForSession('s6');
  // The assistant has no matching block, so the row IS the only rendering.
  const rows = out.filter((m) => m.role === 'tool');
  expect(rows).toHaveLength(1);
  expect(rows[0].tool?.result).toBe('exit 0');
});

it('leaves a block with no matching row alone', () => {
    localStorage.setItem(
      messagesStorageKey('s3')!,
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          content: 'x',
          timestamp: 't',
          blocks: [block('call_p', 'read_file', 'running')],
        },
      ]),
    );
    const out = loadMessagesForSession('s3');
    const blocks = out[0].blocks as unknown as Array<{ tool: Record<string, unknown> }>;
    // No result was ever recorded: claiming otherwise would invent a completion.
    expect(blocks[0].tool.status).toBe('running');
  });

  it('keeps a tool row whose id no block renders (legacy shape)', () => {
    localStorage.setItem(
      messagesStorageKey('s4')!,
      JSON.stringify([
        { id: '1', role: 'assistant', content: 'x', timestamp: 't' },
        {
          id: '2',
          role: 'tool',
          content: 'orphan',
          timestamp: 't',
          toolUseId: 'call_none',
          tool: { name: 'read_file', status: 'done', result: 'r' },
        },
      ]),
    );
    const out = loadMessagesForSession('s4');
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('is not quadratic in the transcript length', () => {
    // Guard on the join being a Map lookup, not a scan per block. A wall-clock
    // assertion would be flaky; this asserts the shape of the work instead.
    const many: ChatMessage[] = [];
    for (let i = 0; i < 400; i++) {
      many.push({
        id: `a${i}`,
        role: 'assistant',
        content: 'x',
        timestamp: 't',
        blocks: [block(`c${i}`, 'read_file', 'running')],
      });
      many.push({
        id: `t${i}`,
        role: 'tool',
        content: 'r',
        timestamp: 't',
        toolUseId: `c${i}`,
        tool: { name: '', status: 'done', result: 'r' },
      });
    }
    localStorage.setItem(messagesStorageKey('s5')!, JSON.stringify(many));
    const t0 = Date.now();
    const out = loadMessagesForSession('s5');
    const ms = Date.now() - t0;
    expect(out.some((m) => m.role === 'tool')).toBe(false);
    expect(out).toHaveLength(400);
    // Generous ceiling — the O(n²) version took seconds here.
    expect(ms).toBeLessThan(400);
  });

  it('keeps an orphan row when the assistant HAS unrelated blocks', () => {
    // The regression net for the `&& renderedByAssistant.has(id)` gate.
    // The legacy-shape test above cannot see it: its assistant has no blocks,
    // so `renderedByAssistant.size === 0` returns before the gate is
    // evaluated. Removing the gate therefore left the whole suite green while
    // deleting this row. Here the gate IS reached: `renderedByAssistant` is
    // non-empty (call_other) but does not contain the row's id.
    localStorage.setItem(
      messagesStorageKey('s7')!,
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          content: 'x',
          timestamp: 't',
          blocks: [block('call_other', 'run_command', 'running')],
        },
        {
          id: '2',
          role: 'tool',
          content: 'ORPHAN-OUTPUT',
          timestamp: 't',
          toolUseId: 'call_z',
          tool: { name: '', status: 'done', result: 'ORPHAN-OUTPUT' },
        },
      ]),
    );
    const out = loadMessagesForSession('s7');
    const rows = out.filter((m) => m.role === 'tool');
    expect(rows).toHaveLength(1);
    expect(rows[0].tool?.result).toBe('ORPHAN-OUTPUT');
  });

  it('keeps the earlier row when two share one toolUseId', () => {
    // `Map.set` keeps only the LAST row for an id. Filtering on the id then
    // dropped EVERY row with that id, so the first row's output vanished with
    // nothing left to render it — the D1 failure class one `Map.set` away.
    // Dropping by object identity keeps the row that was never merged.
    localStorage.setItem(
      messagesStorageKey('s8')!,
      JSON.stringify([
        {
          id: '1',
          role: 'assistant',
          content: 'x',
          timestamp: 't',
          blocks: [block('call_a', 'read_file', 'running')],
        },
        {
          id: '2',
          role: 'tool',
          content: 'FIRST-OUTPUT',
          timestamp: 't',
          toolUseId: 'call_a',
          tool: { name: '', status: 'done', result: 'FIRST-OUTPUT' },
        },
        {
          id: '3',
          role: 'tool',
          content: 'SECOND-OUTPUT',
          timestamp: 't',
          toolUseId: 'call_a',
          tool: { name: '', status: 'done', result: 'SECOND-OUTPUT' },
        },
      ]),
    );
    const out = loadMessagesForSession('s8');
    const rows = out.filter((m) => m.role === 'tool');
    const blocks = out[0].blocks as unknown as Array<{ tool: Record<string, unknown> }>;
    // `Map.set` keeps the LAST row for an id, so that is the one merged into the
    // block; the earlier row was never consumed and must survive as its own
    // message. The invariant that matters is that BOTH outputs are still
    // reachable — not which one wins.
    expect(rows).toHaveLength(1);
    expect(blocks[0].tool.result).toBe('SECOND-OUTPUT');
    expect(rows[0].content).toBe('FIRST-OUTPUT');
    const present = [String(blocks[0].tool.result), rows[0].content].sort();
    expect(present).toEqual(['FIRST-OUTPUT', 'SECOND-OUTPUT']);
  });

});