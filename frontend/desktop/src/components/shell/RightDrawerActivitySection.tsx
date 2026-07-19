/* ── RightDrawerActivitySection — live “what August is doing” ───── */

import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import {
  selectSessionLiveActivity,
  useLiveActivityStore,
  type LiveActivityItem,
  type LiveActivityKind,
} from '@/store/liveActivity';
import { resolveUiSessionId } from '@/sections/chat/stream/session-id-map';

const KIND_IDLE_LABEL: Record<LiveActivityKind, string> = {
  thinking: 'Thought',
  view: 'Viewed',
  edit: 'Edited',
  run: 'Ran',
  tool: 'Used',
};

function itemLabel(item: LiveActivityItem): string {
  if (item.status === 'running') {
    return item.label || 'Working';
  }
  if (item.kind === 'thinking') return KIND_IDLE_LABEL.thinking;
  // Prefer the tool’s own label (e.g. “Read”, “Listed”) when settled.
  return item.label || KIND_IDLE_LABEL[item.kind] || 'Done';
}

function ActivityItemRow({ item }: { item: LiveActivityItem }) {
  const pending = item.status === 'running';
  const detail = item.detail?.trim() || '';

  return (
    <div className="my-0.5" data-slot="drawer-activity-item">
      <ThinkingDisclosure pending={pending} label={itemLabel(item)} omitDurationLabel>
        {detail ? (
          <div className="pl-3 chat-rail py-1 thought-content chat-thought-text whitespace-pre-wrap break-words">
            {detail}
          </div>
        ) : (
          <div className="pl-3 chat-rail py-1 text-[12px] text-muted-foreground/50">
            No details
          </div>
        )}
      </ThinkingDisclosure>
    </div>
  );
}

export function RightDrawerActivitySection({ sessionId }: { sessionId: string | null }) {
  const uiSessionId = sessionId ? resolveUiSessionId(sessionId) : null;
  const activity = useLiveActivityStore((s) =>
    selectSessionLiveActivity(s, uiSessionId),
  );
  const visible = activity.items;
  const title = activity.headline;
  const live = visible.some((item) => item.status === 'running') || !!title;

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="mb-1 text-[12.5px] font-medium text-foreground/90">Activity</div>
      <p className="mb-3 text-[11px] text-muted-foreground/70">
        Live steps while the chat stays compact — so you can see August is still working.
      </p>

      {live && title ? (
        <div className="activity-summary-live mb-3" aria-live="polite">
          <span className="activity-summary-live-dot" aria-hidden />
          <span className="truncate text-[12px]">{title}</span>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="py-8 text-center text-[11px] text-muted-foreground/70">
          {title ? 'Working…' : 'No live activity yet.'}
        </div>
      ) : (
        <div className="activity-summary min-h-0 flex-1 overflow-y-auto pr-0.5">
          <div className="activity-summary-body gap-1">
            {visible.map((item) => (
              <ActivityItemRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
