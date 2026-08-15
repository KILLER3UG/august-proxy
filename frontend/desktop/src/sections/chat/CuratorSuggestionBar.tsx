/* ── CuratorSuggestionBar ──────────────────────────────────────────────── */
/* On-demand skill-curation chip above the composer: one click runs the
 * skill curator in dry-run mode and surfaces the result (stale / archiveable
 * skills) where the user is working. Deliberately on-demand — no polling,
 * since a curation pass touches every agent-authored skill. */

import { useState } from 'react';
import { Wand2, X, Loader2 } from 'lucide-react';
import { api } from '@/api/client';

interface CuratorReport {
  active?: number;
  staled?: Array<{ name?: string } | string>;
  archived?: Array<{ name?: string } | string>;
  errors?: Array<{ name?: string } | string>;
}

function namesOf(list?: Array<{ name?: string } | string>): string[] {
  if (!list) return [];
  return list.map((e) => (typeof e === 'string' ? e : e.name ?? ''));
}

export function CuratorSuggestionBar() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CuratorReport | null>(null);

  const run = () => {
    if (running) return;
    setRunning(true);
    void api
      .post<{ report: CuratorReport }>('/api/curator/run?dryRun=true')
      .then((res) => setReport(res.report ?? {}))
      .catch(() => setReport({ errors: ['Curation pass failed — check backend'] }))
      .finally(() => setRunning(false));
  };

  if (!report) {
    return (
      <button
        type="button"
        onClick={run}
        disabled={running}
        data-testid="curator-chip"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition disabled:opacity-50"
      >
          {running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Wand2 className="size-3 text-primary" />
          )}
          Curate skills (dry run)
      </button>
    );
  }

  const staled = namesOf(report.staled);
  const archived = namesOf(report.archived);
  const errors = namesOf(report.errors);
  const summary = [
    staled.length ? `${staled.length} stale` : '',
    archived.length ? `${archived.length} archiveable` : '',
    errors.length ? `${errors.length} errors` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1.5 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-testid="curator-report"
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <Wand2 className="size-3 text-primary" />
        Curation
      </span>
      <span className="rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px]">
        {summary || 'All skills healthy'}
      </span>
      {staled.slice(0, 3).map((n) => (
        <span key={n} className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] text-warning" title="Stale skill">
          {n}
        </span>
      ))}
      <button
        type="button"
        title="Dismiss"
        className="p-0.5 rounded text-muted-foreground hover:bg-muted"
        onClick={() => setReport(null)}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
