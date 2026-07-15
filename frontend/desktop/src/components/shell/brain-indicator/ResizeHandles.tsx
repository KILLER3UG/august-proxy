import { cn } from '@/lib/utils';
import type { ResizeEdge } from './usePopupResize';
import { MIN_WIDTH } from './popupGeometry';

interface ResizeHandlesProps {
  popupWidth: number;
  handleResizePointerDown: (
    edge: ResizeEdge,
  ) => (e: React.PointerEvent<HTMLDivElement>) => void;
}

/** Eight resize hit targets (corners + edges) plus legacy SE handle for older tests. */
export function ResizeHandles({
  popupWidth,
  handleResizePointerDown,
}: ResizeHandlesProps) {
  const handleStyle =
    'absolute z-10 group hover:bg-primary/20 focus-visible:bg-primary/25 transition';
  const handleFillStyle = 'absolute inset-0';

  return (
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

      {/* Backwards-compatible single resize handle (kept for v4.4.2 tests).
          Points at the SE corner so old assertions still match. */}
      <div
        data-testid="brain-resize-handle"
        data-no-drag
        onPointerDown={handleResizePointerDown('se')}
        className="absolute bottom-0 right-0 size-3 cursor-se-resize z-10"
        aria-label="Resize brain popup"
        aria-valuenow={popupWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={1200}
        style={{ pointerEvents: 'auto' }}
      />
    </>
  );
}
