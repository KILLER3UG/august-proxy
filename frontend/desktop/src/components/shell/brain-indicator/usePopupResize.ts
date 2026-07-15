import { useRef, type MutableRefObject } from 'react';
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  clampState,
  type PopupState,
} from './popupGeometry';

/** Image-editor style: 8 handles (4 corners + 4 edges). */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Resize the Brain popup from corner/edge handles. Each corner resizes both
 * axes; each edge resizes one axis with the opposite edge anchored.
 * Always computed from geometry at pointerdown so moves track the cursor 1:1.
 */
export function usePopupResize(
  geomRef: MutableRefObject<PopupState>,
  setGeom: React.Dispatch<React.SetStateAction<PopupState>>,
  persistGeom: () => void,
) {
  const resizeState = useRef<{
    edge: ResizeEdge;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const handleResizePointerMove = (e: PointerEvent) => {
    const r = resizeState.current;
    if (!r) return;
    if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
    const dx = e.clientX - r.startX;
    const dy = e.clientY - r.startY;
    let nx = r.originX;
    let ny = r.originY;
    let nw = r.originW;
    let nh = r.originH;
    switch (r.edge) {
      case 'e':
        nw = Math.max(MIN_WIDTH, r.originW + dx);
        break;
      case 'w': {
        nw = Math.max(MIN_WIDTH, r.originW - dx);
        nx = r.originX + (r.originW - nw);
        break;
      }
      case 's':
        nh = Math.max(MIN_HEIGHT, r.originH + dy);
        break;
      case 'n': {
        nh = Math.max(MIN_HEIGHT, r.originH - dy);
        ny = r.originY + (r.originH - nh);
        break;
      }
      case 'ne':
        nw = Math.max(MIN_WIDTH, r.originW + dx);
        nh = Math.max(MIN_HEIGHT, r.originH - dy);
        ny = r.originY + (r.originH - nh);
        break;
      case 'nw':
        nw = Math.max(MIN_WIDTH, r.originW - dx);
        nx = r.originX + (r.originW - nw);
        nh = Math.max(MIN_HEIGHT, r.originH - dy);
        ny = r.originY + (r.originH - nh);
        break;
      case 'se':
        nw = Math.max(MIN_WIDTH, r.originW + dx);
        nh = Math.max(MIN_HEIGHT, r.originH + dy);
        break;
      case 'sw':
        nw = Math.max(MIN_WIDTH, r.originW - dx);
        nx = r.originX + (r.originW - nw);
        nh = Math.max(MIN_HEIGHT, r.originH + dy);
        break;
    }
    setGeom(clampState({ x: nx, y: ny, width: nw, height: nh }));
  };

  const handleResizePointerUp = () => {
    if (!resizeState.current) return;
    resizeState.current = null;
    persistGeom();
  };

  const handleResizePointerDown =
    (edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
      const button = e.button ?? 0;
      if (button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const captureEl = e.currentTarget;
      try {
        captureEl.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
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
      const onMove = (ev: PointerEvent) => {
        handleResizePointerMove(ev);
      };
      const onUp = (ev: PointerEvent) => {
        handleResizePointerUp();
        try {
          captureEl.releasePointerCapture?.(ev.pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

  return { handleResizePointerDown };
}
