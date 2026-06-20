/* ── appendBlockEvent.test.ts — unit tests for the block-event reducer ─
 *
 * Focus: the `isRevisedPlan` flag for `august__submit_plan` tool calls.
 * When the streamed event has `isRevisedPlan: true`, the resulting
 * block carries the flag through so MessageBubble can render the
 * "Revised plan vN" badge. For every other event, the block must NOT
 * carry the flag.
 */

import { describe, it, expect } from 'vitest';
import { appendBlockEvent } from '../ChatThread';

describe('appendBlockEvent — isRevisedPlan flag', () => {
  it('sets isRevisedPlan on the block for august__submit_plan tool_use', () => {
    const blocks = appendBlockEvent([], {
      type: 'tool_call',
      name: 'august__submit_plan',
      id: 'call_1',
      context: '{}',
      status: 'running',
      isRevisedPlan: true,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRevisedPlan).toBe(true);
    expect(blocks[0].tool?.name).toBe('august__submit_plan');
  });

  it('does NOT set isRevisedPlan for non-submit_plan tool calls', () => {
    const blocks = appendBlockEvent([], {
      type: 'tool_call',
      name: 'august__write_file',
      id: 'call_2',
      context: '{}',
      status: 'running',
      isRevisedPlan: false,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].isRevisedPlan).toBeUndefined();
  });

  it('does NOT set isRevisedPlan when the flag is omitted', () => {
    const blocks = appendBlockEvent([], {
      type: 'tool_call',
      name: 'august__bash',
      id: 'call_3',
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

  it('appends a new final_output block for text events', () => {
    let blocks = appendBlockEvent([], { type: 'text', content: 'first' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: ' second' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe('first second');
    expect(blocks[0].type).toBe('final_output');
  });

  it('updates tool status on a tool_result event', () => {
    let blocks = appendBlockEvent([], {
      type: 'tool_call',
      name: 'august__bash',
      id: 'call_X',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, {
      type: 'tool_result',
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

describe('appendBlockEvent — derived badge counter (consumer-side logic)', () => {
  // The counter math lives in the messages.map callback in ChatThread
  // (it walks the messages array, not the block reducer), but we can
  // exercise the same derivation here as a pure function so the
  // counter math has unit coverage.
  function derivePlanRevisionNumber(
    messages: Array<{ blocks?: Array<{ tool?: { name: string } }> }>,
    index: number,
  ): number | null {
    const msg = messages[index];
    if (!msg) return null;
    const inThis = (msg.blocks || []).filter(b => b.tool?.name === 'august__submit_plan').length;
    if (inThis === 0) return null;
    return messages.slice(0, index + 1)
      .flatMap(m => m.blocks || [])
      .filter(b => b.tool?.name === 'august__submit_plan').length + 1;
  }

  it('returns null for messages without submit_plan calls', () => {
    const messages = [
      { blocks: [] },
      { blocks: [{ tool: { name: 'august__write_file' } }] },
    ];
    expect(derivePlanRevisionNumber(messages, 0)).toBeNull();
    expect(derivePlanRevisionNumber(messages, 1)).toBeNull();
  });

  it('returns 2 for the first submit_plan call', () => {
    const messages = [
      { blocks: [{ tool: { name: 'august__submit_plan' } }] },
    ];
    expect(derivePlanRevisionNumber(messages, 0)).toBe(2);
  });

  it('returns the displayed cumulative count for subsequent submit_plan calls', () => {
    const messages = [
      { blocks: [{ tool: { name: 'august__submit_plan' } }] },
      { blocks: [{ tool: { name: 'august__write_file' } }] },
      { blocks: [{ tool: { name: 'august__submit_plan' } }] },
    ];
    expect(derivePlanRevisionNumber(messages, 0)).toBe(2);
    expect(derivePlanRevisionNumber(messages, 1)).toBeNull();
    expect(derivePlanRevisionNumber(messages, 2)).toBe(3);
  });
});
