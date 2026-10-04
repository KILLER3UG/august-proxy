/* ── appendBlockEvent.test.ts — unit tests for the block-event reducer ─
 *
 * Focus: the `isRevisedPlan` flag for `august__submit_plan` tool calls.
 * When the streamed event has `isRevisedPlan: true`, the resulting
 * block carries the flag through so MessageBubble can render the
 * "Revised plan vN" badge. For every other event, the block must NOT
 * carry the flag.
 */

import { describe, it, expect } from 'vitest';
import { appendBlockEvent } from '../chat-stream-manager';

describe('appendBlockEvent — basic event merging', () => {
  it('creates a normal tool_call block for august__submit_plan', () => {
    const blocks = appendBlockEvent([], {
      type: 'toolCall',
      name: 'august__submit_plan',
      id: 'call_1',
      context: '{}',
      status: 'running',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRevisedPlan).toBeUndefined();
    expect(blocks[0].tool?.name).toBe('august__submit_plan');
  });

  it('does NOT set isRevisedPlan for non-submit_plan tool calls', () => {
    const blocks = appendBlockEvent([], {
      type: 'toolCall',
      name: 'august__write_file',
      id: 'call_2',
      context: '{}',
      status: 'running',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRevisedPlan).toBeUndefined();
  });

  it('merges thinking events into the previous thinking block', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'part 1' });
    blocks = appendBlockEvent(blocks, { type: 'thinking', content: ' part 2' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('part 1 part 2');
  });

  it('coalesces demoted finalOutput into one thinking block', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'think' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: 'draft' });
    // The narration round ended with a tool call — that toolCall block is what
    // the reclassify marker uses as its boundary (2026-10-03), so it has to
    // be present: a marker with no tool boundary demotes nothing on purpose,
    // because showing narration is recoverable and hiding the answer is not.
    blocks = appendBlockEvent(blocks, {
      type: 'toolCall',
      id: 't1',
      name: 'read_file',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, { type: 'reclassifyText' });
    // The demoted draft coalesced into the open thought…
    expect(blocks[0]).toMatchObject({ type: 'thinking', content: 'thinkdraft' });
    // …and a later thought (after the tool boundary) stays its own block.
    blocks = appendBlockEvent(blocks, { type: 'thinking', content: ' more' });
    expect(blocks.filter((b) => b.type === 'thinking')).toHaveLength(2);
    expect(blocks[0].content).toBe('thinkdraft');
  });

  it('appends a new final_output block for text events', () => {
    let blocks = appendBlockEvent([], { type: 'text', content: 'first' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: ' second' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('first second');
    expect(blocks[0].type).toBe('finalOutput');
  });

  it('handles final_output event type (same as text)', () => {
    let blocks = appendBlockEvent([], { type: 'finalOutput', content: 'hello' });
    blocks = appendBlockEvent(blocks, { type: 'finalOutput', content: ' world' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('hello world');
    expect(blocks[0].type).toBe('finalOutput');
  });

  it('merges final_output into an existing final_output block', () => {
    let blocks = appendBlockEvent([], { type: 'text', content: 'part 1' });
    blocks = appendBlockEvent(blocks, { type: 'finalOutput', content: ' part 2' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('part 1 part 2');
    expect(blocks[0].type).toBe('finalOutput');
  });

  it('updates tool status on a tool_result event', () => {
    let blocks = appendBlockEvent([], {
      type: 'toolCall',
      name: 'august__bash',
      id: 'call_X',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, {
      type: 'toolResult',
      id: 'call_X',
      status: 'done',
      summary: 'all good',
      duration: 120,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool?.status).toBe('done');
    expect(blocks[0].tool?.summary).toBe('all good');
    expect(blocks[0].tool?.duration).toBe(120);
  });
});

