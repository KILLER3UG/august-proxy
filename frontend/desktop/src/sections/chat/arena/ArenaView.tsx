/* ── ArenaView — split-pane overlay for the active arena run ─────────── */
/* Renders every lane's live stream side by side. Picking a winner
 * navigates to that lane's session (full conversation + winning answer)
 * and clears the run; other lanes keep running in the background as
 * ordinary sidebar sessions. */

import { useNavigate } from 'react-router-dom';
import { Swords, X } from 'lucide-react';
import { useArenaStore, clearArenaRun, type ArenaRunLane } from './arena-store';
import { ArenaPane } from './ArenaPane';

export function ArenaView() {
  const run = useArenaStore((s) => s.run);
  const navigate = useNavigate();

  if (!run) return null;

  const pickWinner = (lane: ArenaRunLane) => {
    clearArenaRun();
    navigate(`/c/${lane.uiSessionId}`);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-background/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Arena comparison"
      data-testid="arena-view"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Swords className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Arena</h2>
        <p className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          “{run.prompt}” — {run.lanes.length} models answering in parallel
        </p>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          other lanes keep running after you pick
        </span>
        <button
          type="button"
          onClick={clearArenaRun}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0"
          title="Exit arena (lanes stay in the sidebar)"
          aria-label="Exit arena"
          data-testid="arena-exit"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        className={[
          'flex-1 min-h-0 p-4 grid gap-4 overflow-y-auto',
          run.lanes.length <= 2 ? 'md:grid-cols-2' : 'md:grid-cols-3',
        ].join(' ')}
      >
        {run.lanes.map((lane) => (
          <ArenaPane key={lane.uiSessionId} lane={lane} onPickWinner={pickWinner} />
        ))}
      </div>
    </div>
  );
}
