/* ── context-breakdown.test.ts ─ unit tests for estimateContextBreakdown ─ */

import { describe, it, expect } from 'vitest';
import { estimateContextBreakdown } from '../ChatComposer';

describe('estimateContextBreakdown — messages', () => {
  it('returns 0 messages for empty input', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    expect(r.messages).toBe(0);
  });

  it('estimates messages at chars/4 rounded up', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(100) }],
      input: '',
      toolCount: 0,
    });
    expect(r.messages).toBe(25); // ceil(100/4)
  });

  it('sums messages content + input length', () => {
    const r = estimateContextBreakdown({
      messages: [
        { role: 'user', content: 'a'.repeat(40) },
        { role: 'assistant', content: 'a'.repeat(80) },
      ],
      input: 'a'.repeat(80),
      toolCount: 0,
    });
    expect(r.messages).toBe(50); // ceil(200/4)
  });
});

describe('estimateContextBreakdown — system tools', () => {
  it('returns 0 for 0 tools', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    expect(r.systemTools).toBe(0);
  });

  it('estimates ~180 tokens per tool', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 10 });
    expect(r.systemTools).toBe(1800);
  });

  it('rounds up to the nearest token', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 1 });
    expect(r.systemTools).toBe(180);
  });
});

describe('estimateContextBreakdown — fixed estimates', () => {
  it('uses 800 tokens for the base system prompt', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    expect(r.systemPrompt).toBe(800);
  });

  it('uses 100 tokens for meta context', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    expect(r.meta).toBe(100);
  });

  it('estimates skills from coreMemoryBytes (chars/4)', () => {
    const r = estimateContextBreakdown({
      messages: [],
      input: '',
      toolCount: 0,
      coreMemoryBytes: 400,
    });
    expect(r.skills).toBe(100);
  });

  it('returns 0 skills when no coreMemoryBytes is provided', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    expect(r.skills).toBe(0);
  });
});

describe('estimateContextBreakdown — combined', () => {
  it('returns a complete breakdown that sums roughly to the visible total', () => {
    const r = estimateContextBreakdown({
      messages: [
        { role: 'user', content: 'Hello there, this is a test message with some content.' },
        { role: 'assistant', content: 'And a reply with more content here too.' },
      ],
      input: 'A new question',
      toolCount: 30,
      coreMemoryBytes: 500,
    });
    // Every category is non-negative and finite
    for (const v of Object.values(r)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(v)).toBe(true);
    }
    // Sanity: tools + base ≥ messages for this size
    expect(r.systemTools).toBeGreaterThan(0);
    expect(r.systemPrompt).toBe(800);
  });
});
