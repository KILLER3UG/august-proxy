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

  // ---------- Drag (move) — starts from anywhere on the popup except interactive children ----------
  const dragState = useRef<{
    startX: number; startY: number;
    originX: number; originY: number;
  } | null>(null);

  const handleDragPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    console.log('[DRAG] pointerdown', e.clientX, e.clientY, 'button', e.button);
    const button = e.button ?? 0;
    if (button !== 0) return;
    const target = e.target as HTMLElement;
    const blocked = target.closest('button, [role="tab"], input, textarea, select, [data-no-drag], [contenteditable="true"]');
    if (blocked) {
      console.log('[DRAG] blocked by', blocked);
      return;
    }
    const targetEl = e.currentTarget;
    try { targetEl.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const rect = targetEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: geomRef.current.x - offsetX,
      originY: geomRef.current.y - offsetY,
    };
    console.log('[DRAG] state set, attaching listeners', dragState.current);
    // Attach move/up handlers inline (same pattern as resize)
    const onMove = (ev: PointerEvent) => {
      console.log('[DRAG] move', ev.clientX, ev.clientY);
      handleDragPointerMove(ev);
    };
    const onUp = () => {
      console.log('[DRAG] up');
      handleDragPointerUp();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
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

  const handleDragPointerUp = () => {
    if (!dragState.current) return;
    dragState.current = null;
    persistGeom();
  };

  // ---------- Resize — image-editor style: 8 handles (4 corners + 4 edges) ----------
  // Each corner resizes both axes; each edge resizes one axis with the
  // opposite edge anchored (e.g. dragging E only changes width; W changes
  // both x and width).
  type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  const resizeState = useRef<{
    edge: ResizeEdge;
    startX: number; startY: number;
    originX: number; originY: number;
    originW: number; originH: number;
  } | null>(null);

  const handleResizePointerDown = (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    console.log('[RESIZE] pointerdown edge', edge, e.clientX, e.clientY);
    const button = e.button ?? 0;
    if (button !== 0) return;
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    const g = geomRef.current;
    resizeState.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      originX: g.x,
      originY: g.y,
      originW: g.width,
      originH: g.height,
    };
    console.log('[RESIZE] state set, attaching listeners', resizeState.current);
    const onMove = (ev: PointerEvent) => {
      console.log('[RESIZE] move edge', edge, ev.clientX, ev.clientY);
      handleResizePointerMove(ev);
    };
    const onUp = () => {
      console.log('[RESIZE] up edge', edge);
      handleResizePointerUp();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const handleResizePointerMove = (e: PointerEvent) => {
    const r = resizeState.current;
    if (!r) return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    setGeom((prev) => {
      let { x: nx, y: ny, width: nw, height: nh } = prev;
      switch (r.edge) {
        case 'e':
          nw = Math.max(MIN_WIDTH,  nw + dx); break;
        case 'w':  // west edge — drag any grows width (anchor: east); x follows drag
          nx = nx + dx;
          nw = Math.max(MIN_WIDTH, nw + Math.abs(dx));
          break;
        case 's':  // south edge — drag down grows height (anchor: north)
          nh = Math.max(MIN_HEIGHT, nh + dy); break;
        case 'n':  // north edge — drag any grows height (anchor: south); y follows drag
          ny = ny + dy;
          nh = Math.max(MIN_HEIGHT, nh + Math.abs(dy));
          break;
        case 'ne': // top-right corner — drag down-right grows both (anchor: SW)
          nw = Math.max(MIN_WIDTH,  nw + dx);
          ny = ny + dy;
          nh = Math.max(MIN_HEIGHT, nh + dy);
          break;
        case 'nw': // top-left corner — drag any grows both (anchor: SE); x, y follow
          nx = nx + dx;
          nw = Math.max(MIN_WIDTH, nw + Math.abs(dx));
          ny = ny + dy;
          nh = Math.max(MIN_HEIGHT, nh + Math.abs(dy));
          break;
        case 'se': // bottom-right corner — drag any grows both (anchor: NW)
          nw = Math.max(MIN_WIDTH,  nw + dx);
          nh = Math.max(MIN_HEIGHT, nh + dy);
          break;
        case 'sw': // bottom-left corner — drag any grows both (anchor: NE); x follows drag
          nx = nx + dx;
          nw = Math.max(MIN_WIDTH, nw + Math.abs(dx));
          nh = Math.max(MIN_HEIGHT, nh + dy);
          break;
      }
      return clampState({ x: nx, y: ny, width: nw, height: nh });
    });
  };

  const handleResizePointerUp = () => {
    if (!resizeState.current) return;
    resizeState.current = null;
    persistGeom();
  };

  // Attach window-level move/up listeners while drag or resize is active
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
  handleDragPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  handleResizePointerDown: (edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') =>
    (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const handleStyle = 'absolute z-10 group hover:bg-primary/20 focus-visible:bg-primary/25 transition';
  const handleFillStyle = 'absolute inset-0';
  const cornerHandles = (
    <>
      {/* NW */}
      <div
        data-testid="brain-resize-nw"
        data-brain-resize-edge="nw"
        data-no-drag
        onPointerDown={handleResizePointerDown('nw')}
        className={cn(handleStyle, 'top-0 left-0 size-3 cursor-nw-resize')}
        aria-label="Resize north-west"
      >
        <div className={handleFillStyle} />
      </div>
      {/* NE */}
      <div
        data-testid="brain-resize-ne"
        data-brain-resize-edge="ne"
        data-no-drag
        onPointerDown={handleResizePointerDown('ne')}
        className={cn(handleStyle, 'top-0 right-0 size-3 cursor-ne-resize')}
        aria-label="Resize north-east"
      >
        <div className={handleFillStyle} />
      </div>
      {/* SW */}
      <div
        data-testid="brain-resize-sw"
        data-brain-resize-edge="sw"
        data-no-drag
        onPointerDown={handleResizePointerDown('sw')}
        className={cn(handleStyle, 'bottom-0 left-0 size-3 cursor-sw-resize')}
        aria-label="Resize south-west"
      >
        <div className={handleFillStyle} />
      </div>
      {/* SE */}
      <div
        data-testid="brain-resize-se"
        data-brain-resize-edge="se"
        data-no-drag
        onPointerDown={handleResizePointerDown('se')}
        className={cn(handleStyle, 'bottom-0 right-0 size-3 cursor-se-resize')}
        aria-label="Resize south-east"
      >
        <div className={handleFillStyle} />
      </div>
    </>
  );

  const edgeHandles = (
    <>
      {/* N */}
      <div
        data-testid="brain-resize-n"
        data-brain-resize-edge="n"
        data-no-drag
        onPointerDown={handleResizePointerDown('n')}
        className={cn(handleStyle, 'top-0 left-3 right-3 h-1.5 cursor-n-resize')}
        aria-label="Resize north"
      />
      {/* S */}
      <div
        data-testid="brain-resize-s"
        data-brain-resize-edge="s"
        data-no-drag
        onPointerDown={handleResizePointerDown('s')}
        className={cn(handleStyle, 'bottom-0 left-3 right-3 h-1.5 cursor-s-resize')}
        aria-label="Resize south"
      />
      {/* E */}
      <div
        data-testid="brain-resize-e"
        data-brain-resize-edge="e"
        data-no-drag
        onPointerDown={handleResizePointerDown('e')}
        className={cn(handleStyle, 'top-3 bottom-3 right-0 w-1.5 cursor-e-resize')}
        aria-label="Resize east"
      />
      {/* W */}
      <div
        data-testid="brain-resize-w"
        data-brain-resize-edge="w"
        data-no-drag
        onPointerDown={handleResizePointerDown('w')}
        className={cn(handleStyle, 'top-3 bottom-3 left-0 w-1.5 cursor-w-resize')}
        aria-label="Resize west"
      />
    </>
  );

  return (
    <div
      data-testid="brain-popup"
      data-brain-popup-root
      role="dialog"
      aria-label="Brain activity"
      onPointerDown={handleDragPointerDown}
      className="fixed bg-popover border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden cursor-grab touch-none select-none"
      style={{ left: geom.x, top: geom.y, width: geom.width, height: geom.height }}
    >
      {/* Header (still has the brain-drag-handle testid for backwards compat) */}
      <div
        data-testid="brain-drag-handle"
        className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0"
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

      {/* Tabs (data-no-drag is read by the closest() check inside handleDragPointerDown) */}
      <div
        data-no-drag
        className="flex items-center gap-1 px-2 pt-1.5 border-b border-border shrink-0"
      >
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

      {/* Resize handles (image-editor style) */}
      {cornerHandles}
      {edgeHandles}

      {/* Backwards-compatible single resize handle (kept for v4.4.2 tests).
          Re-exported to point at the SE corner so old assertions still match. */}
      <div
        data-testid="brain-resize-handle"
        data-no-drag
        onPointerDown={handleResizePointerDown('se')}
        className="absolute bottom-0 right-0 size-3 cursor-se-resize z-10"
        aria-label="Resize brain popup"
        aria-valuenow={geom.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={1200}
        style={{ pointerEvents: 'auto' }}
      />
    </div>
  );
}
