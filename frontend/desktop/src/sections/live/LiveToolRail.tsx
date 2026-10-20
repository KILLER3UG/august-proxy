import { Wrench, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { ToolEvent } from './useLiveSession';

interface LiveToolRailProps {
  events: ToolEvent[];
}

const STATUS_ICON = {
  running: Loader2,
  done: CheckCircle2,
  error: XCircle,
};

/** The rail is a narrow column, so the arguments are a SUMMARY of the call,
 *  not its payload: the raw JSON.stringify used to paint an entire object
 *  into a 224 px column, where it wrapped over many lines and pushed the
 *  rest of the rail off screen. */
const ARG_LIMIT = 120;

function argSummary(args: unknown): string {
  if (args === undefined || args === null) return '';
  let text: string;
  if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(args) ?? '';
    } catch {
      return '';
    }
  }
  if (text.length <= ARG_LIMIT) return text;
  return `${text.slice(0, ARG_LIMIT)}…`;
}

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
        const summary = argSummary(e.args);
        return (
          <div
            key={e.id}
            data-status={e.status}
            className="bg-card border border-border rounded-md p-2 flex items-start gap-2 text-xs"
          >
            <Icon
              className={`size-3 mt-0.5 shrink-0 ${
                e.status === 'running' ? 'animate-spin text-warning' : e.status === 'error' ? 'text-danger' : 'text-success'
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="font-mono font-medium truncate">{e.name}</div>
              {summary ? (
                <div className="text-muted-foreground truncate" title={summary}>
                  {summary}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
