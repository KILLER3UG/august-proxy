/* ── turnTelemetry: provenance schema + dispatch (audit A6) ──────────────
 * The three provenance lists are OPTIONAL and are OMITTED ENTIRELY by the
 * backend when empty (turn_close.py spreads each key only when its list is
 * truthy). That asymmetry is the whole point of this file:
 *   - the schema must not require them, or every ordinary turn trips the
 *     soft-validation warning in validateWorkbenchEvent;
 *   - the dispatcher must not invent empty arrays, or the chip renders "0
 *     skills" — a claim the shell never made — on every turn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchWorkbenchEvent, validateWorkbenchEvent } from './streamEvents';
import { WorkbenchTurnTelemetryEventSchema } from '../schemas/workbench';

afterEach(() => vi.restoreAllMocks());

describe('turnTelemetry schema — provenance lists are optional', () => {
  it('accepts a frame carrying all three lists', () => {
    const r = WorkbenchTurnTelemetryEventSchema.safeParse({
      type: 'turnTelemetry',
      ttftMs: 812,
      durationMs: 9021,
      cacheHitTokens: 4096,
      cacheMissTokens: 128,
      inputTokens: 5000,
      outputTokens: 640,
      toolArgsReadyToStreamEndMs: 0,
      skillsInjected: ['quartus-flow', 'reviewer'],
      factsInjected: ['user.timezone'],
      errorFamilies: ['timeout'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts the common frame with NO provenance keys at all', () => {
    // What a turn that injected nothing and hit nothing actually sends.
    const r = WorkbenchTurnTelemetryEventSchema.safeParse({
      type: 'turnTelemetry',
      ttftMs: 300,
      durationMs: 1500,
      cacheHitTokens: 0,
      cacheMissTokens: 200,
      inputTokens: 200,
      outputTokens: 90,
    });
    expect(r.success).toBe(true);
  });

  it('accepts an explicitly empty list (valid JSON, just not what the backend sends)', () => {
    // Rejecting this would turn a harmless drift into a per-turn console
    // warning; the dispatcher is what normalizes it to absent.
    const r = WorkbenchTurnTelemetryEventSchema.safeParse({
      type: 'turnTelemetry',
      skillsInjected: [],
      factsInjected: [],
      errorFamilies: [],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-string entry — the lists are names, never objects', () => {
    const r = WorkbenchTurnTelemetryEventSchema.safeParse({
      type: 'turnTelemetry',
      skillsInjected: [{ name: 'quartus-flow' }],
    });
    expect(r.success).toBe(false);
  });

  it('does not warn on a real frame during soft validation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    validateWorkbenchEvent('turnTelemetry', {
      ttftMs: 1,
      durationMs: 2,
      skillsInjected: ['a'],
      factsInjected: ['b'],
      errorFamilies: ['auth'],
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('turnTelemetry dispatch — onTurnTelemetry', () => {
  it('forwards the three lists under `provenance`', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent(
      'turnTelemetry',
      { skillsInjected: ['reviewer'], factsInjected: ['k1', 'k2'], errorFamilies: ['rate_limit'] },
      { onTurnTelemetry },
    );
    expect(onTurnTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: {
          skillsInjected: ['reviewer'],
          factsInjected: ['k1', 'k2'],
          errorFamilies: ['rate_limit'],
        },
      }),
    );
  });

  it('carries the telemetry numbers too, so a future chip needs no reshim', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent('turnTelemetry', { ttftMs: 42, durationMs: 900, outputTokens: 7 }, {
      onTurnTelemetry,
    });
    expect(onTurnTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ ttftMs: 42, durationMs: 900, outputTokens: 7 }),
    );
  });

  it('omits absent lists rather than sending empty ones', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent('turnTelemetry', { skillsInjected: ['reviewer'] }, { onTurnTelemetry });
    const call = onTurnTelemetry.mock.calls[0][0];
    expect(call.provenance).toEqual({ skillsInjected: ['reviewer'] });
    expect(call.provenance.factsInjected).toBeUndefined();
    expect(call.provenance.errorFamilies).toBeUndefined();
  });

  it('normalizes an explicitly empty list to absent (no "0 skills" chip)', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent('turnTelemetry', { skillsInjected: [], factsInjected: [] }, {
      onTurnTelemetry,
    });
    expect(onTurnTelemetry.mock.calls[0][0].provenance).toBeUndefined();
  });

  it('drops non-string and blank entries instead of rendering them', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent('turnTelemetry', { skillsInjected: ['ok', '', 7, null] }, {
      onTurnTelemetry,
    });
    expect(onTurnTelemetry.mock.calls[0][0].provenance).toEqual({ skillsInjected: ['ok'] });
  });

  it('leaves provenance undefined when the frame reports nothing', () => {
    const onTurnTelemetry = vi.fn();
    dispatchWorkbenchEvent('turnTelemetry', { ttftMs: 10 }, { onTurnTelemetry });
    expect(onTurnTelemetry.mock.calls[0][0].provenance).toBeUndefined();
  });

  it('is a no-op when no handler is registered', () => {
    expect(() => dispatchWorkbenchEvent('turnTelemetry', { skillsInjected: ['x'] }, {})).not.toThrow();
  });
});
