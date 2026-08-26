/* ── RightDrawerTrajectorySection ─ per-turn execution timeline ──── */
/*                                                                        */
/* A turn-aware ledger of what happened inside each workbench turn —      */
/* model, graded outcome, rounds, tokens, duration, tools called and      */
/* self-heal events — plus a timing overview strip on top (dsh-style      */
/* "Trajectory"). Data comes from the existing /api/harness/traces        */
/* endpoint (per-turn trace store), which had no UI consumer before.      */

import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import * as harness from '@/api/harness';
import type { HarnessTrace } from '@/api/harness';

const OUTCOME_META: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  ok: { label: 'ok', tone: 'success' },
  refusal: { label: 'refusal', tone: 'warning' },
  stalled: { label: 'stalled', tone: 'warning' },
  thinking_only: { label: 'thinking only', tone: 'muted' },
  tool_error: { label: 'tool error', tone: 'destructive' },
  error: { label: 'error', tone: 'destructive' },
};

const OUTCOME_ICONS = {
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
  muted: Activity,
} as const;

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function outcomeMeta(outcome: string) {
  return OUTCOME_META[outcome] ?? { label: outcome || 'turn', tone: 'muted' as const };
}

interface SelfHealBadge {
  label: string;
  kind: 'parse' | 'refusal' | 'stall' | 'compact';
}

function selfHealBadges(trace: HarnessTrace): SelfHealBadge[] {
  const e = trace.self_heal_events;
  if (!e) return [];
  const badges: SelfHealBadge[] = [];
  if ((e.parse_failures ?? 0) > 0) {
    badges.push({ label: `parse ×${e.parse_failures}`, kind: 'parse' });
  }
  if ((e.refusals ?? 0) > 0) {
    badges.push({ label: `refusal ×${e.refusals}`, kind: 'refusal' });
  }
  if ((e.stall_nudges ?? 0) > 0) {
    badges.push({ label: 'stall nudge', kind: 'stall' });
  }
  if (e.compacted_this_turn) {
    badges.push({ label: 'compacted', kind: 'compact' });
  }
  return badges;
}

const BADGE_KIND_CLASSES = {
  parse: 'border-warning/25 bg-warning/5 text-warning',
  refusal: 'border-warning/25 bg-warning/5 text-warning',
  stall: 'border-info/25 bg-info/5 text-info',
  compact: 'border-border bg-muted/30 text-muted-foreground',
} as const;

const OUTCOME_TEXT_CLASSES = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-danger',
  muted: 'text-muted-foreground',
} as const;

export function RightDrawerTrajectorySection({ sessionId }: { sessionId: string | null }) {
  const query = useQuery({
    queryKey: ['harness-traces', sessionId],
    queryFn: () => harness.listSessionTraces(sessionId!),
    enabled: !!sessionId,
    refetchInterval: 8_000,
  });

  // The API returns newest-first; the ledger reads chronologically.
  const traces = useMemo(() => [...(query.data ?? [])].reverse(), [query.data]);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  const totalDuration = useMemo(
    () => traces.reduce((sum, t) => sum + (t.duration_ms > 0 ? t.duration_ms : 0), 0),
    [traces],
  );
  const evidenceTurns = useMemo(
    () => traces.filter((t) => t.evidence_state && t.evidence_state !== '').length,
    [traces],
  );

  const focusRow = (id: number) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="flex h-full min-h-0 flex-col drawer-section-text">
      {/* Overview strip — relative start/duration bars, hover to focus. */}
      {traces.length > 0 && (
        <div className="mb-2 shrink-0">
          <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            <Clock className="size-3" />
            Timing overview
            <span className="ml-auto font-mono tabular-nums opacity-70">
              {traces.length} turn{traces.length === 1 ? '' : 's'} · {fmtDuration(totalDuration)}
            </span>
          </div>
          <div className="flex h-5 items-end gap-[2px] rounded-md border border-border/50 bg-muted/20 px-1.5 py-0.5">
            {traces.map((trace) => {
              const pct =
                totalDuration > 0 && trace.duration_ms > 0
                  ? Math.max(2, (trace.duration_ms / totalDuration) * 100)
                  : 2;
              const meta = outcomeMeta(trace.outcome);
              const active = hoveredId === trace.id || focusedId === trace.id;
              return (
                <button
                  key={trace.id}
                  type="button"
                  title={`Turn ${trace.turn_seq} · ${fmtDuration(trace.duration_ms)} · ${meta.label}`}
                  onMouseEnter={() => setHoveredId(trace.id)}
                  onMouseLeave={() => setHoveredId((v) => (v === trace.id ? null : v))}
                  onClick={() => focusRow(trace.id)}
                  className={cn(
                    'h-3 rounded-[2px] transition-all duration-150',
                    meta.tone === 'success' && 'bg-success/60 hover:bg-success',
                    meta.tone === 'warning' && 'bg-warning/60 hover:bg-warning',
                    meta.tone === 'destructive' && 'bg-danger/60 hover:bg-danger',
                    meta.tone === 'muted' && 'bg-muted-foreground/40 hover:bg-muted-foreground/70',
                    active && 'ring-1 ring-primary/70',
                  )}
                  style={{ width: `${pct}%` }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Ledger */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
        {query.isLoading && traces.length === 0 && (
          <div className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border border-border/40 bg-muted/20" />
            ))}
          </div>
        )}

        {!query.isLoading && traces.length === 0 && (
          <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center">
            <Activity className="mx-auto mb-2 size-4 text-muted-foreground/50" />
            <div className="text-xs text-muted-foreground">No turn traces yet.</div>
            <div className="mt-1 text-[10px] leading-snug text-muted-foreground/70">
              Each completed turn records a trace here — model, outcome,
              tokens, duration and tools.
            </div>
          </div>
        )}

        {traces.map((trace) => {
          const meta = outcomeMeta(trace.outcome);
          const BadgeIcon = OUTCOME_ICONS[meta.tone];
          const badges = selfHealBadges(trace);
          const active = hoveredId === trace.id || focusedId === trace.id;
          const live = !trace.outcome;
          return (
            <div
              key={trace.id}
              data-testid={`trajectory-row-${trace.id}`}
              ref={(el) => {
                if (el) rowRefs.current.set(trace.id, el);
                else rowRefs.current.delete(trace.id);
              }}
              onMouseEnter={() => setHoveredId(trace.id)}
              onMouseLeave={() => setHoveredId((v) => (v === trace.id ? null : v))}
              className={cn(
                'group rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-muted/40',
                active && 'bg-primary/5',
              )}
              title={trace.prompt_preview || undefined}
            >
              <div className="flex min-w-0 items-center gap-2 text-[11px] leading-5">
                {/* Leading log glyph — outcome icon tinted by tone. */}
                <BadgeIcon
                  className={cn('size-3 shrink-0', OUTCOME_TEXT_CLASSES[meta.tone])}
                />
                {live && (
                  <span
                    data-testid="trajectory-live"
                    aria-label="turn in progress"
                    className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                  />
                )}
                {/* Human label — "Turn 7", plus a word when the outcome isn't ok. */}
                <span className={cn('shrink-0 font-medium', OUTCOME_TEXT_CLASSES[meta.tone])}>
                  Turn {trace.turn_seq}
                </span>
                {meta.label !== 'ok' && meta.label !== 'turn' && (
                  <span className="shrink-0 text-muted-foreground/80">· {meta.label}</span>
                )}
                {/* Trailing activity meta: rounds, then duration. */}
                {trace.rounds > 0 && (
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    · {trace.rounds} round{trace.rounds === 1 ? '' : 's'}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-muted-foreground/70">
                  · {fmtDuration(trace.duration_ms)}
                </span>
                {/* Tool + self-heal chips, right-aligned, hidden when narrow. */}
                {(trace.tool_calls?.length ?? 0) > 0 || badges.length > 0 ? (
                  <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
                    {(trace.tool_calls ?? []).slice(0, 3).map((tool) => (
                      <span
                        key={tool}
                        title={tool}
                        className="hidden shrink-0 rounded border border-border/60 bg-muted/20 px-1 font-mono text-[9px] text-foreground/60 sm:inline"
                      >
                        {tool}
                      </span>
                    ))}
                    {(trace.tool_calls?.length ?? 0) > 3 && (
                      <span className="shrink-0 text-[9px] text-muted-foreground/60">
                        +{(trace.tool_calls?.length ?? 0) - 3}
                      </span>
                    )}
                    {badges.slice(0, 2).map((badge) => (
                      <span
                        key={badge.label}
                        title={badge.label}
                        className={cn(
                          'hidden shrink-0 rounded border px-1 font-mono text-[9px] sm:inline',
                          BADGE_KIND_CLASSES[badge.kind],
                        )}
                      >
                        {badge.label}
                      </span>
                    ))}
                    {badges.length > 2 && (
                      <span className="shrink-0 text-[9px] text-muted-foreground/60">
                        +{badges.length - 2}
                      </span>
                    )}
                  </span>
                ) : null}
              </div>

              {trace.error ? (
                <div className="truncate pl-5 font-mono text-[9px] text-danger/80" title={trace.error}>
                  {trace.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {evidenceTurns > 0 && (
        <div className="mt-2 shrink-0 rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground/70">
          Routing evidence recorded on {evidenceTurns} turn{evidenceTurns === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
