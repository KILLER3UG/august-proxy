/* Journey tab — episodic timeline of per-turn and system events. */
import { useQuery } from '@tanstack/react-query';
import { History, Sparkles, Zap, Moon, Compass, ListChecks } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageLoader } from '@/components/PageLoader';
import { api } from '@/api/client';

interface TimelineEntry {
  id: number;
  timestamp?: string;
  sessionId?: string;
  eventSummary?: string;
  category?: string;
}

/* Milestones: first occurrence of each learning category + approval events. */
const MILESTONE_DEFS: Array<{
  key: string;
  label: string;
  icon: typeof Sparkles;
  tone: string;
  matches: (it: TimelineEntry) => boolean;
}> = [
  {
    key: 'heuristic',
    label: 'First learned rule',
    icon: Sparkles,
    tone: 'text-primary',
    matches: (it) => it.category === 'heuristic',
  },
  {
    key: 'memory',
    label: 'First memory stored',
    icon: ListChecks,
    tone: 'text-sky-400',
    matches: (it) => it.category === 'memory',
  },
  {
    key: 'review',
    label: 'First reflection',
    icon: Compass,
    tone: 'text-violet-400',
    matches: (it) => it.category === 'review',
  },
  {
    key: 'skill',
    label: 'First skill created',
    icon: Zap,
    tone: 'text-warning',
    matches: (it) =>
      it.category === 'skill_genesis' || /approve|created skill/i.test(it.eventSummary ?? ''),
  },
  {
    key: 'consolidation',
    label: 'First sleep cycle',
    icon: Moon,
    tone: 'text-emerald-400',
    matches: (it) => it.category === 'consolidation',
  },
];

function toDate(ts?: string): Date | null {
  if (!ts) return null;
  // Stored as SQLite 'YYYY-MM-DD HH:MM:SS' (UTC); treat as UTC explicitly.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(ts)
    ? `${ts.replace(' ', 'T')}Z`
    : ts;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDay(ts?: string): string {
  const d = toDate(ts);
  if (!d) return ts?.slice(0, 10) ?? 'Unknown';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(ts?: string): string {
  const d = toDate(ts);
  if (!d) return ts?.slice(11, 19) ?? '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function JourneyTab() {
  const { data, error, isFetching } = useQuery<{ items: TimelineEntry[] }>({
    queryKey: ['brain-timeline'],
    queryFn: async () => api.get<{ items: TimelineEntry[] }>('/api/brain/timeline'),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  if (error) {
    return <div className="p-4 text-danger">Error loading timeline: {error.message}</div>;
  }
  if (!data) {
    return <PageLoader label="Loading timeline…" variant="card" className="py-4" />;
  }
  const items = data.items ?? [];
  if (items.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-xs text-muted-foreground">
          No timeline entries yet — completed turns and memory events will appear here.
        </p>
      </Card>
    );
  }

  const groups = new Map<string, TimelineEntry[]>();
  for (const it of items) {
    const day = formatDay(it.timestamp);
    groups.set(day, [...(groups.get(day) ?? []), it]);
  }

  const milestones = MILESTONE_DEFS.map((def) => {
    const hits = items.filter(def.matches);
    return {
      ...def,
      first: hits.length > 0 ? hits[hits.length - 1] : null,
      count: hits.length,
    };
  }).filter((m) => m.first !== null);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex items-center gap-1.5 text-xs md:col-span-2">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <span className="text-muted-foreground">
          {isFetching ? 'Refreshing…' : `${items.length} events`}
        </span>
      </div>

      {/* Milestones */}
      {milestones.length > 0 ? (
        <Card className="p-4 space-y-2 md:col-span-2">
          <div className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Milestones</h3>
          </div>
          <ul className="flex flex-wrap gap-2">
            {milestones.map((m) => {
              const Icon = m.icon;
              return (
                <li
                  key={m.key}
                  className="text-[11px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-muted/50"
                  data-testid={`milestone-${m.key}`}
                >
                  <Icon className={`size-3.5 ${m.tone}`} />
                  <span className="font-medium">{m.label}</span>
                  <span className="text-muted-foreground">{formatDay(m.first?.timestamp)}</span>
                  {m.count > 1 ? (
                    <span className="text-muted-foreground/70">×{m.count}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {[...groups.entries()].map(([day, dayItems]) => (
        <Card key={day} className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <History className="size-4 text-primary" />
            <h3 className="font-medium text-sm">{day}</h3>
          </div>
          <ul className="space-y-1.5 max-h-96 overflow-y-auto">
            {dayItems.map((it) => (
              <li key={it.id} className="text-xs flex items-start gap-2">
                <span className="text-muted-foreground font-mono shrink-0 w-10">
                  {formatTime(it.timestamp)}
                </span>
                <span className="flex-1 min-w-0">{it.eventSummary}</span>
                {it.category ? (
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full shrink-0">
                    {it.category}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
