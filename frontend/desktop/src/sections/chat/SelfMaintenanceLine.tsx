/* ── SelfMaintenanceLine ────────────────────────────────────────────────── */
/* Replaces the old "Review what I remember" / "Curate skills (dry run)"
 * click-me pills. Maintenance is AUTOMATIC:
 *   - FRESH APP OPEN → full boot pass (TTL prune + vector-mirror reconcile +
 *     skill curation + forced LLM memory review). While it runs this line
 *     shows a live spinner: "Updating memory & skills…".
 *   - Idle → hourly curator + 12h memory review keep it fresh.
 * Removals are never automatic — they surface as proposals for approval.
 * This component is pure status: no buttons, nothing to click. */

import { useQuery } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { api } from '@/api/client';

interface AutoMaintenanceStatus {
  lastRunSummary?: string;
  running?: boolean;
  boot?: {
    running?: boolean;
    startedAt?: string;
    applied?: number;
    skippedRemove?: number;
  };
}

export function SelfMaintenanceLine() {
  // Poll fast while a pass may be running so the spinner appears promptly
  // after app open; settle to a slow poll once idle.
  const { data, isLoading } = useQuery({
    queryKey: ['auto-maintenance-status'],
    queryFn: () => api.get<AutoMaintenanceStatus>('/api/brain/auto-maintenance'),
    refetchInterval: (query) => (query.state.data?.running ? 1_500 : 60_000),
    retry: false,
  });

  if (isLoading && !data) return null;
  const running = Boolean(data?.running);
  const summary = data?.lastRunSummary?.trim();

  if (running) {
    return (
      <div
        className="inline-flex items-center gap-1.5 px-0.5 py-0.5 text-[10px] text-muted-foreground/70"
        data-testid="self-maintenance-line"
        role="status"
        aria-live="polite"
        title="Fresh start: August is bringing memories and skills up to date"
      >
        <Loader2 className="size-2.5 shrink-0 animate-spin opacity-60" />
        <span>Updating memory &amp; skills…</span>
      </div>
    );
  }

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
