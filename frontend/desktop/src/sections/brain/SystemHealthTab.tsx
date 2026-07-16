/* v3 — System Health tab: per-phase status board */
import { Heart } from 'lucide-react';
import { PageLoader } from '@/components/PageLoader';
import { useSystemHealth } from '@/hooks/useSystemHealth';

const STATUS_COLOR: Record<string, string> = {
  'on & healthy': 'text-success',
  'on & failing': 'text-danger',
  off: 'text-muted-foreground',
  'not shipped': 'text-muted-foreground',
};

const DOT_COLOR: Record<string, string> = {
  'on & healthy': 'bg-success',
  'on & failing': 'bg-danger',
  off: 'bg-muted-foreground',
  'not shipped': 'bg-muted',
};

export function SystemHealthTab() {
  const { data, error, isFetching, dataUpdatedAt } = useSystemHealth();

  if (error) {
    return <div className="p-4 text-danger">Error loading health: {error.message}</div>;
  }
  if (!data) {
    return <PageLoader label="Loading system health…" className="py-4" />;
  }

  const allHealthy = data.phases.every((p) => p.status === 'on & healthy' || p.status === 'off');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 px-4 text-xs">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <span className="text-muted-foreground">
          {isFetching ? 'Refreshing…' : dataUpdatedAt ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'Auto-refreshes every 5s'}
        </span>
      </div>
      <div className="grid grid-cols-12 gap-3 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <span className="col-span-4">Phase / Layer</span>
        <span className="col-span-2">Flag</span>
        <span className="col-span-2">Status</span>
        <span className="col-span-4">Detail</span>
      </div>
      {data.phases.map((p) => (
        <div
          key={p.flag}
          className="grid grid-cols-12 gap-3 items-start px-4 py-2.5 bg-card rounded-lg border border-border text-sm"
        >
          <span className="col-span-4 font-medium">{p.layer}</span>
          <code className="col-span-2 text-xs text-muted-foreground">{p.flag}</code>
          <span
            className={`col-span-2 inline-flex items-center gap-1 text-xs font-medium ${
              STATUS_COLOR[p.status] ?? 'text-muted-foreground'
            }`}
          >
            <span className={`size-1.5 rounded-full ${DOT_COLOR[p.status] ?? 'bg-muted'}`} />
            {p.status}
          </span>
          <div className="col-span-4 text-xs text-muted-foreground">
            <p>{p.detail}</p>
            <p className="text-[10px] mt-0.5">
              checked {new Date(p.lastCheckAt).toLocaleTimeString()}
            </p>
          </div>
        </div>
      ))}
      {allHealthy && (
        <div className="p-3 bg-success/10 text-success text-xs rounded-lg flex items-center gap-2">
          <Heart className="size-3.5" /> All cognitive layers are healthy.
        </div>
      )}
    </div>
  );
}