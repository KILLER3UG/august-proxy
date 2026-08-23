/* ── SelfMaintenanceLine ────────────────────────────────────────────────── */
/* Replaces the old "Review what I remember" / "Curate skills (dry run)"
 * click-me pills. Maintenance is AUTOMATIC now:
 *   - skill curation runs hourly in the backend curator loop
 *   - memory review runs on a schedule and auto-applies safe improvements
 *     (removals become proposals for approval, never silent deletes)
 * This line is pure status — quiet, non-interactive text under the composer.
 * Data comes from GET /api/brain/auto-maintenance; hidden when never run. */

import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api } from '@/api/client';

interface AutoMaintenanceStatus {
  lastRunSummary?: string;
}

export function SelfMaintenanceLine() {
  const { data } = useQuery({
    queryKey: ['auto-maintenance-status'],
    queryFn: () => api.get<AutoMaintenanceStatus>('/api/brain/auto-maintenance'),
    refetchInterval: 120_000,
    retry: false,
  });

  const summary = data?.lastRunSummary?.trim();
  if (!summary) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 px-0.5 py-0.5 text-[10px] text-muted-foreground/60"
      data-testid="self-maintenance-line"
      title="August maintains its own memory and skills automatically"
    >
      <Sparkles className="size-2.5 shrink-0 opacity-50" />
      <span>{summary}</span>
    </div>
  );
}
