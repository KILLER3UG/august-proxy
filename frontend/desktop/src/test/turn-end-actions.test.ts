/* ── turn_end recovery actions ───────────────────────────────────────────────
 * A turn that stopped is the one moment the user most wants a one-click path
 * back in. The button set is not cosmetic — each reason needs a different
 * recovery, and two of the distinctions are easy to get backwards:
 *
 *   - `length` gets ONLY "Continue". Regenerating would discard the partial
 *     answer the user is trying to resume — the whole point of the notice.
 *   - An errored message with a visible error block gets NOTHING here, because
 *     the provider bubble already owns retry + switch-model. Two retry
 *     controls on one message reads as a bug.
 */

import { describe, it, expect } from 'vitest';
import { turnEndActions, TURN_END_ACTIONS } from '@/lib/turn-end';

describe('turn_end recovery actions', () => {
  it('offers only Continue for a truncated answer', () => {
    // Regenerate would throw away the partial work the notice exists to save.
    expect(turnEndActions('length')).toEqual(['continue']);
  });

  it('offers only Try again when re-running is the remedy', () => {
    expect(turnEndActions('cap')).toEqual(['retry']);
    expect(turnEndActions('budget')).toEqual(['retry']);
  });

  it('offers both paths for a stall, matching the remedy text', () => {
    expect(turnEndActions('stall-stop')).toEqual(['continue', 'retry']);
  });

  it('offers Try again and Edit prompt for an interruption', () => {
    expect(turnEndActions('interrupted')).toEqual(['retry', 'editPrompt']);
  });

  it('offers nothing while the model waits on user input', () => {
    // The plan/clarify banners already carry the real control here.
    expect(turnEndActions('awaiting-input')).toEqual([]);
  });

  it('falls back to Try again for an unknown backend reason', () => {
    // A reason added server-side later must never render a dead notice.
    expect(turnEndActions('some-future-reason')).toEqual(['retry']);
    expect(turnEndActions(null)).toEqual(['retry']);
    expect(turnEndActions(undefined)).toEqual(['retry']);
  });

  it('stays a Record so an unknown key is a miss, not a crash', () => {
    // TURN_END_PHRASE/TURN_END_REMEDY are Records for the same reason: the
    // backend can introduce a reason this build has never heard of.
    expect(Object.keys(TURN_END_ACTIONS)).toContain('length');
    expect(TURN_END_ACTIONS['nope']).toBeUndefined();
  });

  describe('when the message already renders an error block', () => {
    it('hides every action so the provider bubble owns retry alone', () => {
      expect(turnEndActions('error', true)).toEqual([]);
    });

    it('also hides them when turn_end.error is set without a matching reason', () => {
      // `turn_end.error` is broader than `reason === 'error'`, so the caller
      // passes the block flag; a null/absent reason with an error block must
      // still yield no duplicate retry.
      expect(turnEndActions(null, true)).toEqual([]);
      expect(turnEndActions(undefined, true)).toEqual([]);
    });

    it('still offers Continue for a truncated answer beside an error block', () => {
      // Suppression is scoped to error-flavoured stops. A `length` stop is
      // about the output cap, not the provider, and still needs its resume.
      expect(turnEndActions('length', true)).toEqual(['continue']);
    });

    it('leaves non-error reasons untouched', () => {
      expect(turnEndActions('cap', true)).toEqual(['retry']);
      expect(turnEndActions('stall-stop', true)).toEqual(['continue', 'retry']);
    });
  });

  it('never renders an action set for awaiting-input, error block or not', () => {
    // `awaiting-input` is suppressed unconditionally — its banners own it.
    expect(turnEndActions('awaiting-input', true)).toEqual([]);
    expect(turnEndActions('awaiting-input', false)).toEqual([]);
  });
});
