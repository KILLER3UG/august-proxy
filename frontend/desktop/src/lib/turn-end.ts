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
