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

describe('estimateContextBreakdown — thinking (no double-count)', () => {
  it('returns 0 thinking when there is no separate thinking text', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
      input: '',
      toolCount: 0,
    });
    // Message content alone must not invent a thinking surcharge (old 15% heuristic).
    expect(r.thinking).toBe(0);
  });

  it('counts thinking field / thinking blocks separately from messages', () => {
    const r = estimateContextBreakdown({
      messages: [
        {
          role: 'assistant',
          content: '',
          thinking: 'a'.repeat(40),
          blocks: [{ type: 'thinking', content: 'b'.repeat(40) }],
        },
      ],
      input: '',
      toolCount: 0,
    });
    // Prefer blocks when present: thinking block only (40 chars), not + thinking field.
    expect(r.thinking).toBe(10);
    expect(r.messages).toBe(0);
  });

  it('returns 0 thinking even with scaleToTotal when no thinking text', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
      input: '',
      toolCount: 5,
      scaleToTotal: 10000,
    });
    expect(r.thinking).toBe(0);
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

  it('uses toolTokenEstimate when provided instead of the heuristic', () => {
    const r = estimateContextBreakdown({
      messages: [],
      input: '',
      toolCount: 10,
      toolTokenEstimate: 5432,
    });
    expect(r.systemTools).toBe(5432);
  });
});

describe('estimateContextBreakdown — system prompt (de-inflated)', () => {
  it('uses 1200 (not 3000) for the fallback system prompt — no more inflation', () => {
    const r = estimateContextBreakdown({ messages: [], input: '', toolCount: 0 });
    // Previously a flat 3000 was added regardless of real size, inflating the
    // gauge by >50% for short conversations. Now a smaller constant is used
    // only for the pre-request fallback.
    expect(r.systemPrompt).toBe(1200);
  });

  it('uses 0 system prompt when scaleToTotal is provided (ground truth owns it)', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'hi' }],
      input: '',
      toolCount: 5,
      scaleToTotal: 8000,
    });
    expect(r.systemPrompt).toBe(0);
  });
});

describe('estimateContextBreakdown — fixed estimates', () => {
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

describe('estimateContextBreakdown — scaleToTotal (server ground truth)', () => {
  it('scales categories to sum exactly to scaleToTotal', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
      input: 'a'.repeat(100),
      toolCount: 10, // 1800 tokens
      scaleToTotal: 10000,
    });
    const sum =
      r.messages + r.thinking + r.systemTools + r.systemPrompt + r.skills + r.meta;
    expect(sum).toBe(10000);
  });

  it('scales even when raw total exceeds scaleToTotal', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(10000) }], // 2500 tokens
      input: '',
      toolCount: 50, // 9000 tokens
      scaleToTotal: 5000, // much smaller than raw 11600
    });
    const sum =
      r.messages + r.thinking + r.systemTools + r.systemPrompt + r.skills + r.meta;
    expect(sum).toBe(5000);
  });

  it('attributes everything to messages when raw total is 0', () => {
    const r = estimateContextBreakdown({
      messages: [],
      input: '',
      toolCount: 0,
      scaleToTotal: 8000,
    });
    expect(r.messages).toBe(8000);
    expect(r.thinking).toBe(0);
    expect(r.systemTools).toBe(0);
    expect(r.systemPrompt).toBe(0);
    expect(r.skills).toBe(0);
    expect(r.meta).toBe(0);
  });

  it('does not scale when scaleToTotal is undefined (preserves raw estimates)', () => {
    const r = estimateContextBreakdown({
      messages: [{ role: 'user', content: 'a'.repeat(400) }],
      input: '',
      toolCount: 10,
    });
    // Raw: messages(100) + thinking(0) + systemTools(1800) + systemPrompt(1200) + skills(0) + meta(100)
    expect(r.messages).toBe(100);
    expect(r.systemTools).toBe(1800);
    expect(r.systemPrompt).toBe(1200);
    expect(r.meta).toBe(100);
  });

  it('all categories are non-negative and finite after scaling', () => {
    const r = estimateContextBreakdown({
      messages: [
        { role: 'user', content: 'Hello there, this is a test message with some content.' },
        { role: 'assistant', content: 'And a reply with more content here too.' },
      ],
      input: 'A new question',
      toolCount: 30,
      coreMemoryBytes: 500,
      scaleToTotal: 45000,
    });
    for (const v of Object.values(r)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
