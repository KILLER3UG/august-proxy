/* v4.4.3 — BrainIndicator: titlebar Brain icon + pulse dot + draggable +
 * resizable floating popup. ESC and click-outside no longer close — only the
 * × button (per user request). Position and size persist across reloads.
 *
 * IMPORTANT (v4.4.3 bug fix): the popup is rendered via createPortal to
 * document.body. The chat shell wraps content in framer-motion's
 * `<motion.div>` which applies `transform`, and that creates a
 * containing block for `position: fixed` — making the popup get trapped
 * inside the titlebar and render at the wrong offsets (off-screen on the
 * chat route but visible on routes that don't have motion.div ancestors).
 * Portaling to document.body lets fixed be viewport-relative. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, X, Activity, Heart, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  getBrainEvents,
  openBrainEventStream,
  type BrainEvent,
} from '@/api/api-client';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { BrainActivityTab } from '@/sections/brain/BrainActivityTab';

interface BrainIndicatorProps {
  /** Optional initial unseen-event count (for tests + future bootstrap). */
  initialUnseen?: number;
}

type TabKey = 'activity' | 'learning' | 'health';

const STORAGE_KEY = 'august-brain-popup-state';
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 320;
const MARGIN = 16; // padding from viewport edges

interface PopupState {
  width: number;
  height: number;
  x: number; // left in viewport coords
  y: number; // top in viewport coords
}

function loadState(): PopupState {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PopupState>;
      if (
        typeof parsed.width === 'number' &&
        typeof parsed.height === 'number' &&
        typeof parsed.x === 'number' &&
        typeof parsed.y === 'number'
      ) {
        return clampState(parsed as PopupState);
      }
    }
  } catch {
    /* fall through */
  }
  return defaultState();
}

function defaultState(): PopupState {
  // Default: anchored top-right, just under the title bar (h-12 + 4px)
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: typeof window !== 'undefined' ? Math.max(MARGIN, window.innerWidth - DEFAULT_WIDTH - MARGIN) : 200,
    y: 64, // title bar (~48px) + 16px gap
  };
}

function clampState(s: PopupState): PopupState {
  const w = Math.max(MIN_WIDTH, Math.min(s.width, (typeof window !== 'undefined' ? window.innerWidth : 1200) - MARGIN * 2));
  const h = Math.max(MIN_HEIGHT, Math.min(s.height, (typeof window !== 'undefined' ? window.innerHeight : 800) - MARGIN * 2));
  const x = Math.max(MARGIN, Math.min(s.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - w - MARGIN));
  const y = Math.max(MARGIN, Math.min(s.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - h - MARGIN));
  return { width: w, height: h, x, y };
}

export function BrainIndicator({ initialUnseen = 0 }: BrainIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('activity');
  const [unseen, setUnseen] = useState(initialUnseen);
  const [geom, setGeom] = useState<PopupState>(() => loadState());
  const geomRef = useRef<PopupState>(geom);
  geomRef.current = geom;

  // Pre-fetch recent events so the popup has content instantly
  useQuery({
    queryKey: ['brain-events'],
    queryFn: () => getBrainEvents(200),
    enabled: open,
  });

  // Always-on SSE so we can bump the unseen counter even when popup is closed
  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const event: BrainEvent = JSON.parse(ev.data);
        setUnseen((n) => n + 1);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, []);

  // Persist geometry when popup closes
  const persistGeom = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(geomRef.current));
    } catch {
      /* swallow quota errors */
    }
  }, []);

  // ---------- Drag (move) ----------
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left-button only
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const rect = target.getBoundingClientRect();
    // Click position relative to the popup's top-left
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: geomRef.current.x - offsetX,
      originY: geomRef.current.y - offsetY,
    };
  };

  const handleDragPointerMove = (e: PointerEvent) => {
    const d = dragState.current;
    if (!d) return;
    setGeom((prev) => clampState({
      ...prev,
      x: d.originX + e.clientX,
      y: d.originY + e.clientY,
    }));
  };

  const handleDragPointerUp = (e: PointerEvent) => {
    if (!dragState.current) return;
    dragState.current = null;
    persistGeom();
  };

  // ---------- Resize (bottom-right corner) ----------
  const resizeState = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    resizeState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originW: geomRef.current.width,
      originH: geomRef.current.height,
    };
  };

  const handleResizePointerMove = (e: PointerEvent) => {
    const r = resizeState.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    setGeom((prev) => clampState({
      ...prev,
      width: r.originW + dx,
      height: r.originH + dy,
    }));
  };

  const handleResizePointerUp = (e: PointerEvent) => {
    if (!resizeState.current) return;
    resizeState.current = null;
    persistGeom();
  };

  // Attach window-level move/up listeners only while a drag or resize is active
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      handleDragPointerMove(e);
      handleResizePointerMove(e);
    };
    const onUp = (e: PointerEvent) => {
      handleDragPointerUp(e);
      handleResizePointerUp(e);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  // Persist beforeunload (best-effort)
  useEffect(() => {
    const handler = () => persistGeom();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [persistGeom]);

  // Clamp on viewport resize
  useEffect(() => {
    const onResize = () => setGeom((prev) => clampState(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleOpen = () => {
    setOpen((v) => !v);
    if (!open) setUnseen(0); // opening the popup resets unseen
  };

  const handleClose = () => {
    persistGeom();
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Toggle Brain activity"
        aria-expanded={open}
        data-testid="titlebar-brain-button"
        data-brain-toggle
        className={cn(
          'relative p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition',
          open && 'bg-accent text-foreground',
        )}
        title="Brain activity"
      >
        <Brain className="size-4" />
        {unseen > 0 && (
          <span
            data-testid="brain-pulse-dot"
            className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary ring-2 ring-background animate-pulse"
            aria-label={`${unseen} unseen brain event(s)`}
          />
        )}
      </button>

      {open && createPortal(<PopupContents
        geom={geom}
        tab={tab}
        setTab={setTab}
        handleClose={handleClose}
        handleDragPointerDown={handleDragPointerDown}
        handleResizePointerDown={handleResizePointerDown}
      />, document.body)}
    </>
  );
}

/* ── PopupContents — rendered via createPortal(document.body) so
 * position: fixed escapes any transformed ancestor (e.g. framer-motion
 * <motion.div> in ChatLayout). */
function PopupContents({
  geom,
  tab,
  setTab,
  handleClose,
  handleDragPointerDown,
  handleResizePointerDown,
}: {
  geom: PopupState;
  tab: TabKey;
  setTab: (k: TabKey) => void;
  handleClose: () => void;
  handleDragPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleResizePointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-testid="brain-popup"
      data-brain-popup-root
      role="dialog"
      aria-label="Brain activity"
      className="fixed bg-popover border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      style={{ left: geom.x, top: geom.y, width: geom.width, height: geom.height }}
    >
      {/* Header (drag handle) */}
      <div
        data-testid="brain-drag-handle"
        onPointerDown={handleDragPointerDown}
        className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0 select-none cursor-move touch-none"
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
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground pointer-events-auto"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-2 pt-1.5 border-b border-border shrink-0">
        {(
          [
            { key: 'activity' as const, label: 'Activity', icon: Activity },
            { key: 'learning' as const, label: 'Learning', icon: Sparkles },
            { key: 'health'   as const, label: 'Health',   icon: Heart },
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

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-2">
        {tab === 'activity' && <BrainActivityTab />}
        {tab === 'learning' && <LearningTab />}
        {tab === 'health' && <SystemHealthTab />}
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        data-testid="brain-resize-handle"
        onPointerDown={handleResizePointerDown}
        role="separator"
        aria-label="Resize brain popup"
        className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, var(--dt-muted-foreground) 50%, var(--dt-muted-foreground) 60%, transparent 60%)',
          opacity: 0.5,
        }}
        aria-valuenow={geom.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={1200}
      />
    </div>
  );
}
