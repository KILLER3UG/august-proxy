/* Ordinary Stop must not leave a pending handoff behind.
 *
 * The Stop button used to call buildHandoffSummary + markHandoffPending, so
 * the NEXT turn — on the SAME model — consumed a "previous model was
 * interrupted" brief via takeHandoffSummary and the model narrated a handoff
 * that never happened. The explicit model-switch flow (switchChatModel) is
 * unchanged and still marks one.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  markHandoffPending,
  takeHandoffSummary,
  peekHandoffPending,
  clearHandoffPending,
} from '../handoff-summary';

beforeEach(() => {
  clearHandoffPending('s1');
  clearHandoffPending('s2');
});

describe('handoff is only marked for an explicit model switch', () => {
  it('a plain Stop leaves no pending handoff for the next turn', () => {
    // What ChatThread's `stop` now does: nothing but stop the stream.
    expect(peekHandoffPending('s1')).toBe(false);
    expect(takeHandoffSummary('s1')).toBeNull();
  });

  it('an explicit switch marks one, and the next turn consumes it exactly once', () => {
    // What switchChatModel does for the stop → switch-model flow.
    markHandoffPending('s2', 'Interrupted model was reading a.ts', 'm-old');
    expect(peekHandoffPending('s2')).toBe(true);

    const brief = takeHandoffSummary('s2');
    expect(brief).toContain('m-old');
    expect(brief).toContain('reading a.ts');
    // Consumed — a second turn gets no stale handoff.
    expect(takeHandoffSummary('s2')).toBeNull();
  });

  it('handoffs are per-session: a stop in one chat never bleeds into another', () => {
    markHandoffPending('s2', 'switch brief', 'm-old');
    expect(takeHandoffSummary('s1')).toBeNull();
    expect(takeHandoffSummary('s2')).toContain('switch brief');
  });
});
