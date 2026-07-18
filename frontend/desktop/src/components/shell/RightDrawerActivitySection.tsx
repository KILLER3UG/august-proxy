/* ── RightDrawerActivitySection — live “what August is doing” ───── */

import { Loader2, Eye, Pencil, Terminal, Brain, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useLiveActivityStore,
  type LiveActivityKind,
} from '@/store/liveActivity';

const KIND_ICON: Record<LiveActivityKind, typeof Eye> = {
  thinking: Brain,
  view: Eye,
  edit: Pencil,
  run: Terminal,
  tool: Wrench,
};

export function RightDrawerActivitySection({ sessionId }: { sessionId: string | null }) {
  const headline = useLiveActivityStore((s) => s.headline);
  const items = useLiveActivityStore((s) => s.items);
  const activeSession = useLiveActivityStore((s) => s.sessionId);
  const belongsHere = !sessionId || !activeSession || activeSession === sessionId;
  const visible = belongsHere ? items : [];
  const title = belongsHere ? headline : '';

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="mb-2 text-xs font-medium text-foreground">Activity</div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Live steps while the chat stays compact — so you can see August is still working.
      </p>
      {title ? (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-2 text-[12px]">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
          <span className="truncate font-medium">{title}</span>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-muted-foreground/70">
          {title ? 'Working…' : 'No live activity yet.'}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-0.5">
          {visible.map((item, i) => {
            const Icon = KIND_ICON[item.kind] || Wrench;
            const isLatest = i === visible.length - 1 && item.status === 'running';
            return (
              <li
                key={item.id}
                className={cn(
                  'flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px]',
                  isLatest ? 'bg-info/10 text-foreground' : 'text-muted-foreground',
                )}
              >
                <span className="mt-0.5 shrink-0">
                  {item.status === 'running' ? (
                    <Loader2 className="size-3 animate-spin text-info" />
                  ) : (
                    <Icon className="size-3 opacity-70" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground/90">{item.label}</span>
                  {item.detail ? (
                    <span className="mt-0.5 block truncate font-mono text-[10px] opacity-70">
                      {item.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
