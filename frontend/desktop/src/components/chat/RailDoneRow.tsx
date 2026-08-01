/**
 * RailDoneRow — the terminal marker at the foot of the process rail: a
 * check-circle + "Done" once a turn settles cleanly, or an alert +
 * "Finished with errors" when any step failed. It is the single completion
 * marker for the whole turn (the per-thought / per-edit "Done" chips are
 * gone); the rail line threads down into its icon via the segment caps.
 */

import { AlertCircle, CheckCircle2 } from 'lucide-react';

export function RailDoneRow({ errored = false }: { errored?: boolean }) {
  return (
    <div
      className="rail-row rail-done-row"
      data-slot="rail-done-row"
      data-status={errored ? 'error' : 'done'}
    >
      <span className="rail-line" aria-hidden />
      <div className="rail-gutter" aria-hidden>
        <span className="rail-icon">
          {errored ? (
            <AlertCircle className="rail-glyph text-danger" />
          ) : (
            <CheckCircle2 className="rail-glyph rail-done-glyph" />
          )}
        </span>
      </div>
      <div className="rail-row-body rail-done-label">
        {errored ? 'Finished with errors' : 'Done'}
      </div>
    </div>
  );
}
