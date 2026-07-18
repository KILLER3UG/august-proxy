import { describe, expect, it } from 'vitest';
import { appendBlockEvent } from '../append-block-event';

describe('appendBlockEvent thinking vs final', () => {
  it('demotes provisional finalOutput when thinking resumes', () => {
    let blocks = appendBlockEvent([], { type: 'thinking', content: 'plan…' });
    blocks = appendBlockEvent(blocks, { type: 'text', content: 'Draft answer' });
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'finalOutput']);

    blocks = appendBlockEvent(blocks, { type: 'thinking', content: ' wait' });
    expect(blocks.every((b) => b.type === 'thinking')).toBe(true);
    expect(blocks.map((b) => b.content).join('')).toContain('Draft answer');
    expect(blocks.map((b) => b.content).join('')).toContain('wait');

    blocks = appendBlockEvent(blocks, { type: 'text', content: 'Real final' });
    expect(blocks.filter((b) => b.type === 'finalOutput')).toHaveLength(1);
    expect(blocks[blocks.length - 1].content).toBe('Real final');
  });
});
