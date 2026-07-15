/* Titlebar Brain icon + pulse dot + draggable + resizable floating popup.
 * ESC and click-outside no longer close — only the × button (per user request).
 * Position and size persist across reloads.
 *
 * The popup is rendered via createPortal to document.body. The chat shell wraps
 * content in framer-motion's `<motion.div>` which applies `transform`, and that
 * creates a containing block for `position: fixed` — making the popup get trapped
 * inside the titlebar and render at the wrong offsets (off-screen on the chat
 * route but visible on routes that don't have motion.div ancestors).
 * Portaling to document.body lets fixed be viewport-relative. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  getBrainEvents,
  openBrainEventStream,
  type BrainEvent,
} from '@/api/api-client';
import { BrainPopup } from './BrainPopup';
import {
  STORAGE_KEY,
  clampState,
  loadState,
  type PopupState,
  type TabKey,
} from './popupGeometry';
import { usePopupDrag } from './usePopupDrag';
import { usePopupResize } from './usePopupResize';

interface BrainIndicatorProps {
  /** Optional initial unseen-event count (for tests + future bootstrap). */
  initialUnseen?: number;
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
        const _event: BrainEvent = JSON.parse(ev.data);
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

  const { dragging, handleDragPointerDown } = usePopupDrag(
    geomRef,
    setGeom,
    persistGeom,
  );
  const { handleResizePointerDown } = usePopupResize(
    geomRef,
    setGeom,
    persistGeom,
  );

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

      {open &&
        createPortal(
          <BrainPopup
            geom={geom}
            tab={tab}
            setTab={setTab}
            dragging={dragging}
            handleClose={handleClose}
            handleDragPointerDown={handleDragPointerDown}
            handleResizePointerDown={handleResizePointerDown}
          />,
          document.body,
        )}
    </>
  );
}
