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
    blocks = appendBlockEvent(blocks, { type: 'thinking', content: ' more' });
    expect(blocks.filter((b) => b.type === 'thinking')).toHaveLength(1);
    expect(blocks[0].content).toBe('thinkdraft more');
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

