/* ── Zod schema tests for the Workbench SSE event stream ──────────────
 *
 * Purpose: ensure the WorkbenchEventSchema accepts every variant that
 * the backend currently emits, and rejects malformed payloads so we
 * catch drift early. Each `it()` block constructs a minimal valid
 * payload for one variant, parses it, and asserts the round-trip.
 *
 * Schema shape (mirrors the backend SSE wire format):
 *   - Type discriminator is camelCase (`toolUse`, `toolCall`,
 *     `toolResult`, `userMessageInjected`, …).
 *   - Event fields are flat on the top-level object; only a handful
 *     of variants (`session`, `btw`) carry a `data` sub-object.
 */

import { describe, it, expect } from 'vitest';
import { WorkbenchEventSchema } from '../workbench';

describe('WorkbenchEventSchema — variant round-trip', () => {
  it('accepts a thinking event', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'thinking',
      content: 'reasoning...',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a text event', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'text',
      content: 'Hello world',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a tool_use event with free-form input', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'toolUse',
      id: 'call_1',
      name: 'august__read_file',
      input: { path: '/tmp/x' },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a tool_call event with optional input', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'toolCall',
      id: 'call_2',
      name: 'august__ls',
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a tool_result event with unknown content', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'toolResult',
      id: 'call_1',
      name: 'august__ls',
      content: { ok: true, lines: 42 },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a session event with full WorkbenchSession shape', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'session',
      data: {
        id: 'wb_1',
        title: 'demo',
        provider: 'claude',
        agentId: 'build',
        agentRole: 'build',
        agentMode: 'assistant',
        approved: true,
        approvedAt: null,
        plan: null,
        goal: null,
        lastGoal: null,
        messageCount: 4,
        mutationCount: 0,
        lastMutationAt: null,
        updatedAt: '2026-07-01T00:00:00Z',
        todos: [],
        guardMode: 'plan',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a btw event with id and confidence', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'btw',
      data: { id: 'q_42', answer: '42', confidence: 0.9 },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a compaction event with all metrics', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'compaction',
      headCount: 5,
      tailCount: 10,
      compressedCount: 100,
      originalTokens: 12000,
      compressedTokens: 4000,
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a done event with empty data', () => {
    const ok = WorkbenchEventSchema.safeParse({ type: 'done' });
    expect(ok.success).toBe(true);
  });

  it('accepts an error event', () => {
    const ok = WorkbenchEventSchema.safeParse({
      type: 'error',
      message: 'upstream timeout',
    });
    expect(ok.success).toBe(true);
  });
});

describe('WorkbenchEventSchema — drift detection', () => {
  it('rejects a tool_use event missing required name', () => {
    const bad = WorkbenchEventSchema.safeParse({
      type: 'toolUse',
      id: 'call_1', // missing name
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const bad = WorkbenchEventSchema.safeParse({
      type: 'totally_new_variant',
      data: {},
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a thinking event with non-string content', () => {
    const bad = WorkbenchEventSchema.safeParse({
      type: 'thinking',
      content: 42,
    });
    expect(bad.success).toBe(false);
  });
});