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
  error: 'errored',
  interrupted: 'you stopped it',
  'awaiting-input': 'waiting on your input',
};

export function turnEndPhrase(reason: string): string {
  return TURN_END_PHRASE[reason] ?? reason;
}
