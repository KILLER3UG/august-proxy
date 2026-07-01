import { Wrench, CheckCircle2, Loader2 } from 'lucide-react';
import type { ToolEvent } from './useLiveSession';

interface LiveToolRailProps {
  events: ToolEvent[];
}

const STATUS_ICON = {
  running: Loader2,
  done: CheckCircle2,
  error: CheckCircle2,
};

export function LiveToolRail({ events }: LiveToolRailProps) {
  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground p-3" data-testid="live-tool-rail">
        No tool activity yet.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="live-tool-rail">
      {events.map((e) => {
        const Icon = STATUS_ICON[e.status] ?? Wrench;
        return (
          <div
            key={e.id}
            data-status={e.status}
            className="bg-card border border-border rounded-md p-2 flex items-start gap-2 text-xs"
          >
            <Icon
              className={`size-3.5 mt-0.5 shrink-0 ${
                e.status === 'running' ? 'animate-spin text-warning' : 'text-success'
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="font-mono font-medium">{e.name}</div>
              <div className="text-muted-foreground truncate">{JSON.stringify(e.args)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
