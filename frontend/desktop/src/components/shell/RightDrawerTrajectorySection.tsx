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
  FileText,
  Hash,
  Repeat,
  XCircle,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import * as harness from '@/api/harness';
import type { HarnessTrace } from '@/api/harness';

const OUTCOME_META: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'muted' }
> = {
  ok: { label: 'ok', tone: 'success' },
  verified: { label: 'verified', tone: 'success' },
  verifier_blocked: { label: 'verifier blocked', tone: 'warning' },
  refusal: { label: 'refusal', tone: 'warning' },
  stalled: { label: 'stalled', tone: 'warning' },
  thinking_only: { label: 'thinking only', tone: 'muted' },
  tool_error: { label: 'tool error', tone: 'destructive' },
  error: { label: 'error', tone: 'destructive' },
};

const TONE_CLASSES = {
  success: 'border-success/25 bg-success/5 text-success',
  warning: 'border-warning/25 bg-warning/5 text-warning',
  destructive: 'border-danger/25 bg-danger/5 text-danger',
  muted: 'border-border bg-muted/30 text-muted-foreground',
} as const;

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

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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
          return (
            <div
              key={trace.id}
              ref={(el) => {
                if (el) rowRefs.current.set(trace.id, el);
                else rowRefs.current.delete(trace.id);
              }}
              onMouseEnter={() => setHoveredId(trace.id)}
              onMouseLeave={() => setHoveredId((v) => (v === trace.id ? null : v))}
              className={cn(
                'rounded-lg border border-border/50 bg-card/40 p-2 transition-colors duration-150',
                active && 'border-primary/40 bg-primary/5',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  <Hash className="size-2.5" />
                  {trace.turn_seq}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold',
                    TONE_CLASSES[meta.tone],
                  )}
                >
                  <BadgeIcon className="size-2.5" />
                  {meta.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                  {trace.model || trace.provider || '—'}
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tabular-nums text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Zap className="size-2.5 text-muted-foreground/50" />
                  {fmtTokens(trace.input_tokens)} in · {fmtTokens(trace.output_tokens)} out
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-2.5 text-muted-foreground/50" />
                  {fmtDuration(trace.duration_ms)}
                </span>
                {trace.rounds > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Repeat className="size-2.5 text-muted-foreground/50" />
                    {trace.rounds} round{trace.rounds === 1 ? '' : 's'}
                  </span>
                )}
              </div>

              {trace.prompt_preview && (
                <div className="mt-1 truncate text-[10px] italic leading-snug text-muted-foreground/60" title={trace.prompt_preview}>
                  {trace.prompt_preview}
                </div>
              )}

              {(trace.tool_calls && trace.tool_calls.length > 0) || badges.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(trace.tool_calls ?? []).slice(0, 6).map((tool) => (
                    <span
                      key={tool}
                      className="inline-flex items-center gap-1 rounded border border-border/60 bg-muted/20 px-1.5 py-px font-mono text-[9px] text-foreground/70"
                    >
                      <FileText className="size-2 text-muted-foreground/50" />
                      {tool}
                    </span>
                  ))}
                  {(trace.tool_calls?.length ?? 0) > 6 && (
                    <span className="px-1 text-[9px] text-muted-foreground/60">
                      +{(trace.tool_calls?.length ?? 0) - 6} more
                    </span>
                  )}
                  {badges.map((badge) => (
                    <span
                      key={badge.label}
                      className={cn(
                        'rounded border px-1.5 py-px font-mono text-[9px]',
                        BADGE_KIND_CLASSES[badge.kind],
                      )}
                    >
                      {badge.label}
                    </span>
                  ))}
                </div>
              ) : null}

              {trace.error ? (
                <div className="mt-1 truncate font-mono text-[9px] text-danger/80" title={trace.error}>
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
