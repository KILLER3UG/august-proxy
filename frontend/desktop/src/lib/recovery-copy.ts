/**
 * Copy for the `recovery` frame — the harness's unified self-correction
 * notice.
 *
 * The backend emits ONE frame for every rescue path (budget ladder, context
 * reduction, auto-compact, length continuation, runaway backstop, stuck
 * request) with a `kind`, an `attempt`, an `outcome` and a `degraded` flag.
 * Until now the frame was dispatched and then dropped: the schema accepted
 * it, the dispatcher had a case for it, the type declared it — and no handler
 * ever supplied one. So a turn that was truncated, rescued into a reduced
 * tool surface, or flattened after a provider refusal shipped as a
 * normal-looking answer.
 *
 * The register is the same as the warning notice: plain, user-facing, no
 * internal token names. `degraded` is the trust signal — the turn LOOKS
 * complete but was rescued under the user — so when it is true the line says
 * so in as many words.
 */

/** The line that carries the "the answer may be incomplete" warning. */
const DEGRADED_SUFFIX = ' The answer may be incomplete.';

/** One line per (kind, outcome) pair. */
const BY_KIND: Record<string, Record<string, string>> = {
  budget: {
    degraded: 'The turn hit its cost budget, so the agent carried on with a reduced set of tools.',
    compacted: 'The turn hit its cost budget, so the conversation was compacted to make room.',
    stopped: 'The turn hit its cost budget and stopped early.',
  },
  runaway: {
    nudged: 'The turn was not changing anything, so the agent was nudged.',
    stopped: 'The turn was not changing anything, so it was stopped.',
  },
  'context-reduction': {
    reduced: 'The conversation was too large, so older turns were reduced to make room.',
    failed: 'The conversation was too large and could not be reduced automatically.',
  },
  'auto-compact': {
    compacted: 'The conversation was compacted before this turn.',
  },
  'length-continuation': {
    retrying: 'The answer hit the length limit, so the agent carried on with it.',
    exhausted: 'The answer hit the length limit and could not be carried on.',
  },
  'stuck-request': {
    flattened:
      'The provider rejected the request, so earlier tool calls were flattened into text and the turn was retried.',
    bare: 'The provider rejected the request, so the turn was retried with a bare set of tools.',
  },
};

/** Fallbacks for a kind we do not know, and for a kind we know but an
 *  outcome we do not. A rescue the user is never told about is the defect
 *  this whole module exists to fix, so an unknown kind still gets a line. */
const BY_KIND_FALLBACK: Record<string, string> = {
  budget: 'The turn hit its cost budget and was adjusted to keep going.',
  runaway: 'The turn was not making progress and was adjusted.',
  'context-reduction': 'The conversation was too large and was reduced to make room.',
  'auto-compact': 'The conversation was compacted before this turn.',
  'length-continuation': 'The answer hit the length limit and was continued.',
  'stuck-request': 'The provider rejected the request, so the turn was retried in a simpler shape.',
};

const GENERIC = 'The agent adjusted this turn mid-flight.';

/**
 * The user-facing line for one recovery frame.
 *
 * Never returns an empty string: an unrecognised kind still produces the
 * generic line, because a silent drop is exactly the failure this replaces.
 */
export function recoveryMessage(
  kind?: string,
  attempt?: number,
  outcome?: string,
  degraded?: boolean,
): string {
  const k = typeof kind === 'string' ? kind : '';
  const o = typeof outcome === 'string' ? outcome : '';

  const byOutcome = BY_KIND[k]?.[o];
  const fallback = BY_KIND_FALLBACK[k] ?? GENERIC;
  let line = byOutcome ?? fallback;

  // The rung number only helps when there was more than one.
  if (typeof attempt === 'number' && attempt > 1) {
    line += ` (step ${attempt})`;
  }
  if (degraded === true) {
    line += DEGRADED_SUFFIX;
  }
  return line;
}
