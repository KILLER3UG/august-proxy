/* ── TurnEndActionRow ────────────────────────────────────────────────────────
 * The recovery controls under a turn_end notice.
 *
 * This component lives in its OWN file, so it must use the shared Button
 * primitive rather than a raw one: the design ratchet is keyed on
 * `path:match` with no counts, so a raw element in a NEW file fails CI even
 * though an already-baselined file gets extra ones for free.
 */

import type { TurnEndAction } from '@/lib/turn-end';
import { Button } from '@/components/ui/button';

const LABELS: Record<TurnEndAction, string> = {
  continue: 'Continue',
  retry: 'Try again',
  editPrompt: 'Edit prompt',
};

export function TurnEndActionRow({
  actions,
  streaming,
  onContinue,
  onRetry,
  onEditPrompt,
}: {
  actions: TurnEndAction[];
  streaming?: boolean;
  /** Resume the stopped turn from where it broke — keeps partial work. */
  onContinue?: () => void;
  /** Re-run the turn from the prompt — discards the partial answer. */
  onRetry?: () => void;
  /** Open the originating user message for editing. */
  onEditPrompt?: () => void;
}) {
  // `awaiting-input` and an error block that already owns retry both arrive
  // here as an empty list — no row at all is the correct rendering.
  if (actions.length === 0) return null;

  // `handleEdit` no-ops while streaming, so a live edit button would be a
  // dead control. Hide it rather than disabling it: a disabled button invites
  // the user to wait for a condition they cannot see.
  const visible = actions.filter((a) => a !== 'editPrompt' || !streaming);
  if (visible.length === 0) return null;

  // Explicit per-action handlers. A shared fallback would make "Try again"
  // resume instead of re-run, silently discarding the wrong thing.
  const HANDLERS: Record<TurnEndAction, (() => void) | undefined> = {
    continue: onContinue,
    retry: onRetry,
    editPrompt: onEditPrompt,
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="turn-end-actions">
      {visible.map((action) => (
        <Button
          key={action}
          type="button"
          variant="outline"
          size="sm"
          data-testid={`turn-end-${action}`}
          onClick={() => {
            HANDLERS[action]?.();
          }}
          title={
            action === 'editPrompt'
              ? 'Open the prompt for editing, then press Send to re-run'
              : undefined
          }
        >
          {LABELS[action]}
        </Button>
      ))}
    </div>
  );
}
