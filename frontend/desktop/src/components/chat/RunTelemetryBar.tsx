/* ── RunTelemetryBar — turn metrics + tool execution latency waterfall ──── */
/* Shows prompt cache hit rate, time-to-first-token (TTFT), tokens/sec, and  */
/* an expandable per-tool execution latency waterfall.                     */

import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Zap, Clock, Ban, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ToolTimingItem {
  id: string;
  name: string;
  durationMs?: number;
  startedAtMs?: number;
  blocked?: boolean;
  isError?: boolean;
  status?: string;
}

export interface RunTelemetryBarProps {
  sessionId?: string | null;
  cacheHitRate?: number | null;
  ttftMs?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  roundCount?: number;
  toolTimings?: ToolTimingItem[];
  streaming?: boolean;
  className?: string;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokensPerSec(tokens: number, durationMs: number): string {
  if (!durationMs || durationMs <= 0 || !tokens) return '0 t/s';
  const tps = (tokens / durationMs) * 1000;
  return `${tps.toFixed(1)} t/s`;
}

export function RunTelemetryBar({
  cacheHitRate,
  ttftMs,
  outputTokens,
  durationMs,
  roundCount,
  toolTimings = [],
  streaming,
  className,
}: RunTelemetryBarProps) {
  const [expanded, setExpanded] = useState(false);

  const hasCache = typeof cacheHitRate === 'number' && cacheHitRate > 0;
  const hasTtft = typeof ttftMs === 'number' && ttftMs > 0;
  const hasTps = typeof outputTokens === 'number' && typeof durationMs === 'number' && durationMs > 0 && outputTokens > 0;
  const hasTools = toolTimings.length > 0;

  if (!hasCache && !hasTtft && !hasTps && !hasTools && !streaming) {
    return null;
  }

  // Calculate earliest tool start to offset bars
  const startTimes = toolTimings.map((t) => t.startedAtMs).filter((t): t is number => typeof t === 'number');
  const minStart = startTimes.length ? Math.min(...startTimes) : 0;
  const totalSpanMs = toolTimings.reduce((max, t) => {
    const startOffset = t.startedAtMs && minStart ? Math.max(0, t.startedAtMs - minStart) : 0;
    const dur = t.durationMs ?? 0;
    return Math.max(max, startOffset + dur);
  }, 100);

  return (
    <div
      className={cn(
        'border-b border-border/30 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground transition-all',
        className,
      )}
      data-testid="run-telemetry-bar"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
            <Activity className="size-3 text-primary" />
            <span>Telemetry</span>
          </span>

          {hasCache && (
            <span className="inline-flex items-center gap-1" title="Prompt Cache Hit Rate">
              <Zap className="size-3 text-emerald-400" />
              <span className="font-mono tabular-nums text-emerald-400">
                {(cacheHitRate * 100).toFixed(0)}% cache
              </span>
            </span>
          )}

          {hasTtft && (
            <span className="inline-flex items-center gap-1" title="Time to first token">
              <Clock className="size-3 text-sky-400" />
              <span className="font-mono tabular-nums text-sky-400">
                {formatDuration(ttftMs)} TTFT
              </span>
            </span>
          )}

          {hasTps && outputTokens && durationMs && (
            <span className="inline-flex items-center gap-1" title="Generation speed">
              <span className="font-mono tabular-nums text-foreground/80">
                {formatTokensPerSec(outputTokens, durationMs)}
              </span>
            </span>
          )}

          {typeof roundCount === 'number' && roundCount > 1 && (
            <span className="rounded bg-muted/60 px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground">
              {roundCount} rounds
            </span>
          )}
        </div>

        {hasTools && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-muted/50 hover:text-foreground transition-colors"
            data-testid="telemetry-waterfall-toggle"
          >
            <span>{toolTimings.length} {toolTimings.length === 1 ? 'tool' : 'tools'}</span>
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
      </div>

      {expanded && hasTools && (
        <div
          className="mt-2 space-y-1.5 border-t border-border/20 pt-2"
          data-testid="telemetry-waterfall"
        >
          <div className="text-[10px] font-medium text-foreground/70 mb-1">
            Tool Execution Latency Waterfall
          </div>
          {toolTimings.map((tool, idx) => {
            const startOffset = tool.startedAtMs && minStart ? Math.max(0, tool.startedAtMs - minStart) : 0;
            const dur = tool.durationMs ?? 0;
            const leftPct = Math.min(90, (startOffset / totalSpanMs) * 100);
            const widthPct = tool.blocked ? 4 : Math.max(8, Math.min(100 - leftPct, (dur / totalSpanMs) * 100));

            return (
              <div key={tool.id || idx} className="flex items-center gap-2 text-[10px]">
                <div className="flex w-28 items-center gap-1 truncate text-foreground/80" title={tool.name}>
                  {tool.blocked ? (
                    <Ban className="size-2.5 shrink-0 text-amber-400" />
                  ) : tool.isError ? (
                    <AlertCircle className="size-2.5 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2 className="size-2.5 shrink-0 text-emerald-400" />
                  )}
                  <span className="truncate font-mono">{tool.name}</span>
                </div>

                <div className="relative h-3 flex-1 rounded bg-muted/40 overflow-hidden">
                  <div
                    className={cn(
                      'absolute top-0 bottom-0 rounded transition-all',
                      tool.blocked
                        ? 'bg-amber-400/40 border border-amber-400/80'
                        : tool.isError
                          ? 'bg-destructive/60'
                          : 'bg-primary/60',
                    )}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                    }}
                    title={
                      tool.blocked
                        ? 'Blocked by policy'
                        : `Duration: ${formatDuration(dur)} (offset +${formatDuration(startOffset)})`
                    }
                  />
                </div>

                <div className="w-14 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {tool.blocked ? (
                    <span className="text-amber-400">blocked</span>
                  ) : (
                    formatDuration(dur)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
