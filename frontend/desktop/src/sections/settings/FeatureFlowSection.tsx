/* ── Feature Flow — live backend pipeline animation + inventory ─────── */
/* Implements the out-of-phase handoff workstream:
 *  - Feature Flow Schema & Events via /api/monitor/events SSE
 *  - Trace animations + real-time error visualization
 *  - Feature Inventory Directory UI
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  GitBranch,
  Pause,
  Play,
  Radio,
  Sparkles,
} from 'lucide-react';
import {
  getFeatureFlowEvents,
  getFeatureInventory,
  openFeatureFlowEventStream,
  type FeatureFlowEvent,
  type FeatureInventoryItem,
} from '@/api/api-client';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { FeatureFlowCanvas } from './FeatureFlowCanvas';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-sky-400 animate-pulse',
  ok: 'bg-success',
  error: 'bg-danger animate-pulse',
};

function FeatureFlowSkeleton() {
  return (
    <div className="px-8 py-10 max-w-5xl space-y-8" data-testid="feature-flow-skeleton">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <div className="space-y-2 rounded-xl border border-white/[0.06] bg-card/40 p-3">
          <Skeleton className="h-3 w-20 mb-2" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeatureFlowSection() {
  const [selectedFeature, setSelectedFeature] = useState<string | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [liveEvents, setLiveEvents] = useState<FeatureFlowEvent[]>([]);

  const invQ = useQuery({
    queryKey: ['feature-inventory'],
    queryFn: getFeatureInventory,
  });

  const eventsQ = useQuery({
    queryKey: ['feature-flow-events'],
    queryFn: () => getFeatureFlowEvents(200),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    const es = openFeatureFlowEventStream();
    es.onmessage = (ev: MessageEvent) => {
      if (paused) return;
      try {
        const event = JSON.parse(ev.data) as FeatureFlowEvent;
        setLiveEvents((prev) => [event, ...prev].slice(0, 300));
      } catch {
        /* ignore malformed */
      }
    };
    return () => es.close();
  }, [paused]);

  const features: FeatureInventoryItem[] = invQ.data?.features ?? [];

  const merged = useMemo(() => {
    const seen = new Set<string>();
    const out: FeatureFlowEvent[] = [];
    for (const e of liveEvents) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    for (const e of eventsQ.data ?? []) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
      }
    }
    return out;
  }, [liveEvents, eventsQ.data]);

  const filtered = useMemo(() => {
    return merged.filter((e) => {
      if (selectedFeature !== 'all' && e.feature !== selectedFeature) return false;
      if (errorsOnly && e.status !== 'error') return false;
      return true;
    });
  }, [merged, selectedFeature, errorsOnly]);

  const activeTraceId = filtered[0]?.traceId;
  const activeFeatureId =
    selectedFeature !== 'all' ? selectedFeature : filtered[0]?.feature ?? 'proxy';
  const activeFeature = features.find((f) => f.id === activeFeatureId) ?? features[0];

  const stageStatus = useMemo(() => {
    const map: Record<string, string> = {};
    if (!activeTraceId) return map;
    const forTrace = [...filtered]
      .filter((e) => e.traceId === activeTraceId)
      .reverse();
    for (const e of forTrace) {
      map[e.stage] = e.status;
    }
    return map;
  }, [filtered, activeTraceId]);

  const pulseKey = filtered[0]?.id;

  const errorCount = useMemo(
    () => merged.filter((e) => e.status === 'error').length,
    [merged],
  );

  if (invQ.isLoading) {
    return <FeatureFlowSkeleton />;
  }

  return (
    <div className="px-8 py-10 max-w-5xl space-y-8" data-testid="feature-flow-section">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <GitBranch className="size-5 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">Feature Flow</h1>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Live 2D visualization of backend feature execution — proxy hops, tools, memory, and more.
          Events stream over SSE from <code className="font-mono text-xs">/api/monitor/events</code>.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside
          className="space-y-2 rounded-xl border border-white/[0.06] bg-card/40 p-3"
          data-testid="feature-inventory-directory"
        >
          <div className="flex items-center gap-1.5 px-1 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <Sparkles className="size-3.5" />
            Inventory
          </div>
          <button
            type="button"
            onClick={() => setSelectedFeature('all')}
            className={cn(
              'w-full text-left rounded-md px-2.5 py-2 text-xs transition border',
              selectedFeature === 'all'
                ? 'bg-primary/15 border-primary/40 text-foreground'
                : 'border-transparent hover:bg-white/[0.04] text-muted-foreground',
            )}
          >
            All features
          </button>
          {features.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedFeature(f.id)}
              data-testid={`feature-inv-${f.id}`}
              className={cn(
                'w-full text-left rounded-md px-2.5 py-2 text-xs transition border space-y-0.5',
                selectedFeature === f.id
                  ? 'bg-primary/15 border-primary/40 text-foreground'
                  : 'border-transparent hover:bg-white/[0.04] text-muted-foreground',
              )}
            >
              <div className="font-medium text-foreground/90">{f.name}</div>
              <div className="text-[10px] text-muted-foreground line-clamp-2">{f.description}</div>
            </button>
          ))}
        </aside>

        <div className="space-y-4 min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className={cn(
                  'size-2 rounded-full',
                  paused ? 'bg-muted-foreground' : 'bg-success animate-pulse',
                )}
              />
              <span className="text-muted-foreground">{paused ? 'Paused' : 'Live'}</span>
              <Radio className="size-3 text-muted-foreground/60 ml-1" />
            </div>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              data-testid="feature-flow-pause"
              className="px-2 py-1 text-xs rounded border border-white/[0.06] hover:bg-white/[0.06] flex items-center gap-1"
            >
              {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              onClick={() => setErrorsOnly((v) => !v)}
              data-testid="feature-flow-errors-only"
              className={cn(
                'px-2 py-1 text-xs rounded border flex items-center gap-1',
                errorsOnly
                  ? 'border-danger/40 bg-danger/10 text-danger'
                  : 'border-white/[0.06] text-muted-foreground hover:bg-white/[0.04]',
              )}
            >
              <AlertTriangle className="size-3" />
              Errors only{errorCount > 0 ? ` (${errorCount})` : ''}
            </button>
            {activeTraceId && (
              <span className="text-[10px] font-mono text-muted-foreground ml-auto truncate max-w-[14rem]">
                trace {activeTraceId}
              </span>
            )}
          </div>

          {activeFeature && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-foreground/80 flex items-center gap-2">
                <Activity className="size-3.5" />
                {activeFeature.name} pipeline
              </div>
              <FeatureFlowCanvas
                stages={activeFeature.stages}
                stageStatus={stageStatus}
                pulseKey={pulseKey}
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-14 border border-dashed border-white/[0.06] rounded-lg">
              <Sparkles className="size-4 inline-block mr-2 opacity-40" />
              No feature-flow events yet — use the proxy or workbench to light up the pipeline.
            </div>
          ) : (
            <ul
              className="space-y-1 max-h-[50vh] overflow-y-auto"
              data-testid="feature-flow-feed"
            >
              {filtered.map((e) => {
                const isErr = e.status === 'error';
                return (
                  <li
                    key={e.id}
                    data-testid="feature-flow-event"
                    data-status={e.status}
                    data-feature={e.feature}
                    className={cn(
                      'rounded-md border p-2 text-xs flex gap-3 transition',
                      isErr
                        ? 'border-danger/40 bg-danger/10 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.15)]'
                        : e.status === 'running'
                          ? 'border-sky-500/30 bg-sky-500/5'
                          : 'border-white/[0.06] bg-card/50',
                    )}
                  >
                    <span className="text-muted-foreground/70 font-mono shrink-0 w-[4.5rem]">
                      {new Date(e.at).toLocaleTimeString()}
                    </span>
                    <span
                      className={cn(
                        'size-2 mt-1 rounded-full shrink-0',
                        STATUS_DOT[e.status] || 'bg-muted-foreground',
                      )}
                    />
                    <span className="shrink-0 w-20 truncate font-mono text-[10px] uppercase text-muted-foreground">
                      {e.feature}
                    </span>
                    <span className="shrink-0 w-16 truncate font-mono text-[10px] text-primary/80">
                      {e.stage}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className={cn(isErr && 'text-danger font-medium')}>{e.summary}</span>
                      {e.error && (
                        <div className="mt-0.5 text-[10px] text-danger/90 font-mono break-all">
                          {e.error}
                        </div>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
