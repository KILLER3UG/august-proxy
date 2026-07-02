/* ── Subagent View Settings Section ──────────────────────────────────── */
/* Controls for subagent panel view preference (collapsed/expanded). */

import { useSubagentViewPreference } from '@/hooks/useSubagentViewPreference';
import { Maximize2, Minimize2 } from 'lucide-react';

export function SubagentViewSection() {
  const { view, setView } = useSubagentViewPreference();

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">Sub-agent View</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Choose how sub-agent progress is displayed by default.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setView('expanded')}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
            view === 'expanded'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-white/[0.06] hover:bg-white/[0.06]'
          }`}
        >
          <Maximize2 className="size-3" />
          Expanded
        </button>
        <button
          type="button"
          onClick={() => setView('collapsed')}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
            view === 'collapsed'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-white/[0.06] hover:bg-white/[0.06]'
          }`}
        >
          <Minimize2 className="size-3" />
          Collapsed
        </button>
      </div>
    </div>
  );
}
