/* v4.3 — Brain Activity tab: live feed of brain events with chip filters + pause. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pause, Play, Sparkles } from 'lucide-react';
import { getBrainEvents, openBrainEventStream, type BrainEvent } from '@/api/api-client';

const CATEGORIES: Array<{ key: BrainEvent['category'] | 'all'; label: string; color: string }> = [
  { key: 'all',          label: 'All',           color: 'text-foreground' },
  { key: 'consolidation', label: 'Consolidation', color: 'text-info' },
  { key: 'heuristic',     label: 'Heuristics',    color: 'text-success' },
  { key: 'delta_engine',  label: 'Delta Engine',  color: 'text-warning' },
  { key: 'review',        label: 'Review',        color: 'text-primary' },
  { key: 'skill_genesis', label: 'Skill Genesis', color: 'text-accent' },
];

const CATEGORY_COLOR: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.color]),
);

export function BrainActivityTab() {
  const [activeChip, setActiveChip] = useState<BrainEvent['category'] | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [liveEvents, setLiveEvents] = useState<BrainEvent[]>([]);

  const eventsQ = useQuery({
    queryKey: ['brain-events', activeChip],
    queryFn: () => getBrainEvents(200),
  });

  // SSE: when not paused, push events into liveEvents (capped).
  // We don't filter live events by chip — UI does it client-side.
  const streamRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = openBrainEventStream();
    streamRef.current = es;
    es.onmessage = (ev: MessageEvent) => {
      if (paused) return;
      try {
        const event = JSON.parse(ev.data) as BrainEvent;
        setLiveEvents((prev) => [event, ...prev].slice(0, 200));
      } catch {
        // Ignore malformed frames
      }
    };
    return () => {
      es.close();
      streamRef.current = null;
    };
  }, [paused]);

  // Merge recent + live. Live takes precedence on dedupe by id.
  const merged = useMemo(() => {
    const seen = new Set<string>();
    const combined: BrainEvent[] = [];
    for (const e of liveEvents) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        combined.push(e);
      }
    }
    for (const e of eventsQ.data ?? []) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        combined.push(e);
      }
    }
    return combined;
  }, [eventsQ.data, liveEvents]);

  const filtered = useMemo(() => {
    if (activeChip === 'all') return merged;
    return merged.filter((e) => e.category === activeChip);
  }, [merged, activeChip]);

  if (eventsQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: status indicator + pause + filter chips */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={`size-2 rounded-full ${paused ? 'bg-muted-foreground' : 'bg-success animate-pulse'}`}
            aria-hidden
          />
          <span className="text-muted-foreground">{paused ? 'Paused' : 'Live'}</span>
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-label={paused ? 'Resume' : 'Pause'}
          data-testid="brain-activity-pause"
          className="px-2 py-1 text-xs rounded border border-white/[0.06] hover:bg-white/[0.06] flex items-center gap-1"
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          <span>{paused ? 'Resume' : 'Pause'}</span>
        </button>

        <div className="flex flex-wrap gap-1.5 ml-2" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setActiveChip(c.key)}
              data-testid={`brain-chip-${c.key}`}
              className={`px-2 py-1 text-xs rounded-full border transition ${
                activeChip === c.key
                  ? 'bg-primary/20 border-primary text-foreground'
                  : 'border-white/[0.06] text-muted-foreground hover:bg-white/[0.03]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Event feed */}
      {filtered.length === 0 ? (
        <div className="text-xs text-muted-foreground text-center py-12 border border-dashed border-white/[0.06] rounded-lg">
          <Sparkles className="size-4 inline-block mr-2 opacity-40" />
          No brain activity yet — start chatting to see the brain learn.
        </div>
      ) : (
        <ul
          className="space-y-1 max-h-[60vh] overflow-y-auto"
          data-testid="brain-activity-feed"
        >
          {filtered.map((e) => (
            <li
              key={e.id}
              data-testid="brain-event"
              data-category={e.category}
              className="bg-card/60 border border-white/[0.06] rounded-md p-2 text-xs flex gap-3"
            >
              <span className="text-muted-foreground/70 font-mono shrink-0 w-20">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span
                className={`shrink-0 w-24 truncate text-[10px] uppercase tracking-wide ${CATEGORY_COLOR[e.category] ?? 'text-muted-foreground'}`}
              >
                {e.category.replace('_', ' ')}
              </span>
              <span className="flex-1">{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
