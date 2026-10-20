/* ── phase-labels — the USER-FACING name of an `update_state` phase ────
 *
 * The phase vocabulary itself (`research | plan | implement | review |
 * complete`) is the TOOL CONTRACT: it is in the tool's schema enum, in the
 * error message the model reads back, and in the system prompt. Renaming a
 * phase would break every session already carrying it, so it stays.
 *
 * What was wrong is the phase reaching the SCREEN raw. The working
 * indicator's fallback pill rendered `execution.phase` verbatim in caps, so
 * the pill literally read "RESEARCH" and read like the name of the feature
 * the user was looking at, rather than a piece of progress bookkeeping. The
 * plan tree's group heading had the same problem in lower case.
 *
 * So the phase is translated here, in ONE place, and both surfaces use it.
 */

/** The phase enum, in the order the prompt teaches it. */
export const PHASE_ORDER = [
  'research',
  'plan',
  'implement',
  'review',
  'complete',
] as const;

/** The phase's name as a person would write it. */
const PHASE_LABELS: Record<string, string> = {
  research: 'Research',
  plan: 'Plan',
  implement: 'Implement',
  review: 'Review',
  complete: 'Complete',
};

/**
 * The phase's user-facing name.
 *
 * An UNKNOWN phase is title-cased rather than dropped: the phase comes
 * from the model, and a phase this build does not know is still the
 * model's business — hiding it would make a real state invisible.
 */
export function phaseLabel(phase: string | null | undefined): string {
  const raw = (phase ?? '').trim().toLowerCase();
  if (!raw) return '';
  const known = PHASE_LABELS[raw];
  if (known) return known;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
