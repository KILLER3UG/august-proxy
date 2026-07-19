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
