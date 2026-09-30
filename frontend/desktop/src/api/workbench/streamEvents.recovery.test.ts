/* The unified `recovery` frame must reach the UI.
 *
 * The backend emits one `recovery {kind, attempt, outcome, degraded}` for every
 * self-correction rescue — the budget ladder, reactive context reduction,
 * auto-compact, length continuation, and the runaway backstop. The Zod schema
 * has always accepted it, and the dispatcher had no `case 'recovery'` at all,
 * so every rescue the harness performed was validated and then dropped on the
 * floor: no error, no log, no UI. The user read a normal-looking answer that
 * had in fact been truncated or rescued into a reduced tool surface.
 *
 * `degraded` is the trust signal, so a dropped recovery frame is the harness
 * quietly lying about how much of the answer is real.
 *
 * The structural version of this check lives in scripts/check-sse-parity.mjs;
 * this file pins the actual behaviour, so a future refactor cannot keep the
 * case while losing the fields.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchWorkbenchEvent } from './streamEvents';
import { WorkbenchEventSchema } from '../schemas/workbench';

describe('recovery frame', () => {
  it('surfaces a degraded rescue with every field intact', () => {
    const onRecovery = vi.fn();
    dispatchWorkbenchEvent(
      'recovery',
      { kind: 'budget', attempt: 1, outcome: 'degraded', degraded: true },
      { onRecovery },
    );
    expect(onRecovery).toHaveBeenCalledWith({
      kind: 'budget',
      attempt: 1,
      outcome: 'degraded',
      degraded: true,
    });
  });

  it('reports the runaway backstop stop', () => {
    const onRecovery = vi.fn();
    dispatchWorkbenchEvent(
      'recovery',
      { kind: 'runaway', attempt: 40, outcome: 'stopped', degraded: true },
      { onRecovery },
    );
    expect(onRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'runaway', outcome: 'stopped', degraded: true }),
    );
  });

  it('reports a rescue that failed to help', () => {
    const onRecovery = vi.fn();
    dispatchWorkbenchEvent(
      'recovery',
      { kind: 'context-reduction', attempt: 1, outcome: 'failed', degraded: true },
      { onRecovery },
    );
    expect(onRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
  });

  it('coerces a malformed payload to undefined rather than passing junk through', () => {
    const onRecovery = vi.fn();
    dispatchWorkbenchEvent(
      'recovery',
      { kind: 123, attempt: 'two', outcome: {}, degraded: 'yes' },
      { onRecovery },
    );
    expect(onRecovery).toHaveBeenCalledWith({
      kind: undefined,
      attempt: undefined,
      outcome: undefined,
      degraded: undefined,
    });
  });

  it('passes schema validation, so a dropped frame was never a validation error', () => {
    // The reason this defect was invisible: the frame validated cleanly, so
    // there was no warning to follow. Assert it validates.
    const parsed = WorkbenchEventSchema.safeParse({
      type: 'recovery',
      kind: 'budget',
      attempt: 2,
      outcome: 'stopped',
      degraded: true,
    });
    expect(parsed.success).toBe(true);
  });
});
