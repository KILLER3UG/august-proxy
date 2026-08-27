import { describe, expect, it } from 'vitest';
import { appendBlockEvent, coalesceAdjacentThinking } from '../append-block-event';

describe('appendBlockEvent thinking vs final', () => {
  it('demotes provisional finalOutput when thinking resumes', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'plan…' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: 'Draft answer' });
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'finalOutput']);

    blocks = appendBlockEvent(blocks, { type: 'thinking', content: ' wait' });
    // Demotion must coalesce adjacent thinking — not Thought (2).
    expect(blocks.filter((b) => b.type === 'thinking')).toHaveLength(1);
    expect(blocks[0].content).toContain('plan…');
    expect(blocks[0].content).toContain('Draft answer');
    expect(blocks[0].content).toContain('wait');

    blocks = appendBlockEvent(blocks, { type: 'text', content: 'Real final' });
    expect(blocks.filter((b) => b.type === 'finalOutput')).toHaveLength(1);
    expect(blocks[blocks.length - 1].content).toBe('Real final');
  });

  it('system thinking (warnings/info/errors) does NOT demote the final answer', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'plan…' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: 'The real answer' });
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'finalOutput']);

    // A system notice arrives after the answer — it must collapse into
    // thinking WITHOUT displacing the real final answer.
    blocks = appendBlockEvent(blocks, {
      type: 'thinking',
      content: '⚠️ Context window approaching limit',
      system: true,
    });
    // The answer block is still finalOutput (not demoted to thinking).
    const finalBlocks = blocks.filter((b) => b.type === 'finalOutput');
    expect(finalBlocks).toHaveLength(1);
    expect(finalBlocks[0].content).toBe('The real answer');
    // The warning is in the thinking pack.
    const thinking = blocks.filter((b) => b.type === 'thinking');
    expect(thinking.some((b) => b.content?.includes('⚠️'))).toBe(true);
  });

  it('keeps thinking segments separated by tools', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'a' });
    blocks = appendBlockEvent(blocks, {
      type: 'toolCall',
      id: 't1',
      name: 'grep',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, { type: 'thinking', content: 'b' });
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'toolCall', 'thinking']);
    expect(blocks[0].content).toBe('a');
    expect(blocks[2].content).toBe('b');
  });
});

describe('coalesceAdjacentThinking', () => {
  it('merges only adjacent thinking blocks', () => {
    const merged = coalesceAdjacentThinking([
      { id: '1', type: 'thinking', content: 'a' },
      { id: '2', type: 'thinking', content: 'b' },
      {
        id: '3',
        type: 'toolCall',
        tool: { id: 't', name: 'grep', context: '', status: 'done' },
      },
      { id: '4', type: 'thinking', content: 'c' },
    ]);
    expect(merged.map((b) => b.type)).toEqual(['thinking', 'toolCall', 'thinking']);
    expect(merged[0].content).toBe('ab');
    expect(merged[2].content).toBe('c');
  });
});

describe('appendBlockEvent toolResult statuses', () => {
  it('marks the tool card error when the result status is error', () => {
    let blocks = appendBlockEvent([], {
      type: 'toolCall',
      id: 't1',
      name: 'run_command',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, {
      type: 'toolResult',
      id: 't1',
      status: 'error',
      summary: 'failed',
      error: 'Error: boom',
    });
    expect(blocks[0].tool?.status).toBe('error');
    expect(blocks[0].tool?.error).toContain('boom');
  });

  it('keeps done status on a successful toolResult', () => {
    let blocks = appendBlockEvent([], {
      type: 'toolCall',
      id: 't2',
      name: 'grep',
      context: '{}',
      status: 'running',
    });
    blocks = appendBlockEvent(blocks, {
      type: 'toolResult',
      id: 't2',
      status: 'done',
      summary: 'matched',
    });
    expect(blocks[0].tool?.status).toBe('done');
    expect(blocks[0].tool?.error).toBe('');
  });
});

describe('appendBlockEvent executionState (plan-tree markers)', () => {
  it('appends a phase block for a new phase', () => {
    const blocks = appendBlockEvent([], {
      type: 'executionState',
      phase: 'Investigate',
      step: 1,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('phase');
    expect(blocks[0].content).toBe('Investigate');
    expect(blocks[0].step).toBe(1);
  });

  it('patches the step in place when the same phase repeats', () => {
    let blocks = appendBlockEvent([], {
      type: 'executionState',
      phase: 'Fix',
      step: 1,
    });
    blocks = appendBlockEvent(blocks, {
      type: 'executionState',
      phase: 'Fix',
      step: 2,
    });
    expect(blocks.filter((b) => b.type === 'phase')).toHaveLength(1);
    expect(blocks[0].step).toBe(2);
  });

  it('starts a new phase block when the phase changes', () => {
    let blocks = appendBlockEvent([], {
      type: 'executionState',
      phase: 'Investigate',
      step: 1,
    });
    blocks = appendBlockEvent(blocks, {
      type: 'executionState',
      phase: 'Fix',
      step: 2,
    });
    expect(blocks.filter((b) => b.type === 'phase')).toHaveLength(2);
    expect(blocks[1].content).toBe('Fix');
  });

  it('ignores empty phases', () => {
    const blocks = appendBlockEvent([], { type: 'executionState', phase: '  ' });
    expect(blocks).toHaveLength(0);
  });
});

describe('appendBlockEvent memoryUpdated', () => {
  it('appends a memoryNotice block with the summary', () => {
    const blocks = appendBlockEvent([], {
      type: 'memoryUpdated',
      summary: 'Remembered: User prefers dark mode',
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('memoryNotice');
    expect(blocks[0].content).toBe('Remembered: User prefers dark mode');
  });

  it('caps stacked notices so a long run cannot pile them up', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'work' });
    for (let i = 0; i < 6; i++) {
      blocks = appendBlockEvent(blocks, { type: 'memoryUpdated', summary: `fact ${i}` });
    }
    const notices = blocks.filter((b) => b.type === 'memoryNotice');
    expect(notices.length).toBeLessThanOrEqual(4);
    // The newest notice is always present (it replaces the oldest slot).
    expect(notices.map((n) => n.content)).toContain('fact 5');
  });
});
