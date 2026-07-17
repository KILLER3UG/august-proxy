import { useRef, useState, type MutableRefObject } from 'react';
import { clampState, type PopupState } from './popupGeometry';

/**
 * Drag-to-move for the Brain popup. Geometry is always origin(at pointerdown)
 * + cursor delta so the popup tracks the pointer 1:1 (never frame-to-frame accumulate).
 * Starts from anywhere on the popup except interactive children (buttons, tabs, inputs).
 */
export function usePopupDrag(
  geomRef: MutableRefObject<PopupState>,
  setGeom: React.Dispatch<React.SetStateAction<PopupState>>,
  persistGeom: () => void,
) {
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    pointerId: number;
    captureEl: HTMLElement | null;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleDragPointerMove = (e: PointerEvent) => {
    const d = dragState.current;
    if (!d) return;
    if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
    // Position = original top-left + cursor delta (tracks cursor 1:1).
    setGeom((prev) =>
      clampState({
        ...prev,
        x: d.originX + (e.clientX - d.startX),
        y: d.originY + (e.clientY - d.startY),
      }),
    );
  };

  const handleDragPointerUp = () => {
    if (!dragState.current) return;
    dragState.current = null;
    persistGeom();
  };

  const handleDragPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const button = e.button ?? 0;
    if (button !== 0) return;
    const target = e.target as HTMLElement;
    const blocked = target.closest(
      'button, [role="tab"], input, textarea, select, a, [data-no-drag], [contenteditable="true"]',
    );
    if (blocked) return;
    // Prefer capturing on the popup root so moves keep firing if the cursor
    // leaves the element (image-editor style drag).
    const captureEl =
      e.currentTarget.closest<HTMLElement>('[data-brain-popup-root]') ??
      e.currentTarget;
    try {
      captureEl.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: geomRef.current.x,
      originY: geomRef.current.y,
      pointerId: e.pointerId,
      captureEl,
    };
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      // Ignore other pointers / zeroed events
      if (ev.pointerId != null && ev.pointerId !== dragState.current?.pointerId) return;
      handleDragPointerMove(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId != null && dragState.current && ev.pointerId !== dragState.current.pointerId) {
        return;
      }
      const cap = dragState.current?.captureEl;
      handleDragPointerUp();
      setDragging(false);
      try {
        cap?.releasePointerCapture?.(ev.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // window-level listeners survive portal re-renders and leave-viewport moves
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return { dragging, handleDragPointerDown };
}
