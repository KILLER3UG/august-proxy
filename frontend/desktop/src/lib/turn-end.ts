/* turn_end.reason in plain words — shared so the transcript badge and the
 * Learning panel's verdict chips phrase the same stop identically. The raw
 * token stays in each tooltip (it's what the event log / `turn_outcomes`
 * column stores). Unknown tokens fall through unchanged so a backend reason
 * added later never renders blank. */

export const TURN_END_PHRASE: Record<string, string> = {
  finished: 'answered',
  length: 'hit output limit',
  cap: 'tool-round cap',
  'stall-stop': 'stalled then stopped',
  budget: 'budget reached',
  error: 'errored',
  interrupted: 'you stopped it',
  'awaiting-input': 'waiting on your input',
};

/* What the user can DO about it. A badge that only names the stop leaves the
 * reader to guess the remedy, and the only detail we had was a `title`
 * attribute — unreachable by keyboard and by touch. Every remedy here is a
 * thing the user can actually do in this app; each names the control, which is
 * the pattern both reference harnesses use (their explainer tables always end
 * in the exact command or click). */
export const TURN_END_REMEDY: Record<string, string> = {
  length: 'the answer was cut off. Send another message to continue from here.',
  cap: `the tool-round cap stopped this turn. Raise it in Settings → Turn Limits, or ask for a smaller step.`,
  'stall-stop': `it repeated itself without making progress. Send "continue" to try a different approach, or narrow the task.`,
  budget: `this turn hit a budget limit and was degraded. Raise the budget in Settings → Turn Limits, or split the task.`,
  error: 'something failed while running this turn. Open the log for the failing tool, then retry.',
  interrupted: 'you stopped this turn. Send a message to pick it back up.',
  'awaiting-input': 'the model is waiting on your input before it can continue.',
};

export function turnEndPhrase(reason: string): string {
  return TURN_END_PHRASE[reason] ?? reason;
}

export function turnEndRemedy(reason: string): string | null {
  return TURN_END_REMEDY[reason] ?? null;
}

/* ── What the user can CLICK about it ───────────────────────────────────────
 * The remedy text above names a remedy; this is the control that performs it.
 * The reference UIs both hang the recovery off the notice itself rather than
 * making the reader scroll to the composer, and a turn that stopped is the
 * one moment the user most wants a one-click path back in.
 *
 * `'continue'` is deliberately distinct from `'retry'`: a turn that stopped on
 * `length` or `stall-stop` has partial work worth keeping, so re-running from
 * the prompt would throw it away. Regenerating is only right when the whole
 * turn was wasted (cap, budget, interrupted, error).
 */
export type TurnEndAction = 'continue' | 'retry' | 'editPrompt';

export const TURN_END_ACTIONS: Record<string, TurnEndAction[]> = {
  // Regenerate would discard the partial answer the user wants resumed.
  length: ['continue'],
  cap: ['retry'],
  budget: ['retry'],
  // The remedy text already names both paths.
  'stall-stop': ['continue', 'retry'],
  interrupted: ['retry', 'editPrompt'],
  // `error` is handled by the caller, not here: a turn can end with
  // `turn_end.error` set for reasons other than `reason === 'error'`, and when
  // the provider bubble already owns retry+switch-model we must not double up.
  // See turnEndActions() below.
  'awaiting-input': [],
};

/**
 * Actions for a stop reason. Unknown reasons fall back to a single `retry` so a
 * backend reason added later never renders a dead notice with no way out.
 *
 * @param hasErrorBlock when the message carries an `error` block, `error`-flavoured
 *   stops return `[]` — the provider bubble already offers retry and
 *   switch-model, and two retry controls on one message read as a bug. We key
 *   this off the rendered block rather than the reason string because
 *   `turn_end.error` is broader than `reason === 'error'`.
 */
export function turnEndActions(reason: string | null | undefined, hasErrorBlock = false): TurnEndAction[] {
  if (reason === 'awaiting-input') return [];
  if (hasErrorBlock && (reason === 'error' || reason === null || reason === undefined)) return [];
  const actions = reason ? TURN_END_ACTIONS[reason] : undefined;
  return actions ?? ['retry'];
}
