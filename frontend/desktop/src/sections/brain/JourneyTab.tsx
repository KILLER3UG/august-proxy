/* Journey tab — episodic timeline of per-turn and system events. */
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
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
