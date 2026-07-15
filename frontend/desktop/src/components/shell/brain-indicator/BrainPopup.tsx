/* PopupContents — rendered via createPortal(document.body) so
 * position: fixed escapes any transformed ancestor (e.g. framer-motion
 * <motion.div> in ChatLayout). */
import { Brain, X, Activity, Heart, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { BrainActivityTab } from '@/sections/brain/BrainActivityTab';
import type { PopupState, TabKey } from './popupGeometry';
import type { ResizeEdge } from './usePopupResize';
import { ResizeHandles } from './ResizeHandles';

export interface BrainPopupProps {
  geom: PopupState;
  tab: TabKey;
  setTab: (k: TabKey) => void;
  dragging: boolean;
  handleClose: () => void;
  handleDragPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  handleResizePointerDown: (
    edge: ResizeEdge,
  ) => (e: React.PointerEvent<HTMLDivElement>) => void;
}

/**
 * Floating Brain panel: drag surface, Activity/Learning/Health tabs, and
 * image-editor-style resize handles. ESC and click-outside do not close —
 * only the × button does.
 */
export function BrainPopup({
  geom,
  tab,
  setTab,
  dragging,
  handleClose,
  handleDragPointerDown,
  handleResizePointerDown,
}: BrainPopupProps) {
  return (
    <div
      data-testid="brain-popup"
      data-brain-popup-root
      role="dialog"
      aria-label="Brain activity"
      onPointerDown={handleDragPointerDown}
      className={cn(
        'fixed bg-popover border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden touch-none select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
      style={{ left: geom.x, top: geom.y, width: geom.width, height: geom.height }}
    >
      {/* Header — primary drag surface (testid kept for tests / backwards compat) */}
      <div
        data-testid="brain-drag-handle"
        onPointerDown={handleDragPointerDown}
        className={cn(
          'flex items-center justify-between px-3 py-2 border-b border-border shrink-0',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <Brain className="size-4 text-primary" />
          <span className="text-sm font-semibold">Brain</span>
          <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
            realtime flow
          </span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground pointer-events-auto cursor-pointer"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Tabs (data-no-drag is read by the closest() check inside handleDragPointerDown) */}
      <div
        data-no-drag
        className="flex items-center gap-1 px-2 pt-1.5 border-b border-border shrink-0"
      >
        {(
          [
            { key: 'activity' as const, label: 'Activity', icon: Activity },
            { key: 'learning' as const, label: 'Learning', icon: Sparkles },
            { key: 'health' as const, label: 'Health', icon: Heart },
          ]
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-t-md border-b-2 transition',
              tab === key
                ? 'border-primary text-foreground bg-popover'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
            data-testid={`brain-popup-tab-${key}`}
          >
            <Icon className="size-3" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {tab === 'activity' && <BrainActivityTab />}
        {tab === 'learning' && <LearningTab />}
        {tab === 'health' && <SystemHealthTab />}
      </div>

      <ResizeHandles
        popupWidth={geom.width}
        handleResizePointerDown={handleResizePointerDown}
      />
    </div>
  );
}
