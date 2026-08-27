/* ── Camera popover ──────────────────────────────────────────────────── */
/* Inline webcam preview with Start/Stop + Capture controls.               */
/* Renders next to the composer actions menu, anchored to the trigger.     */
/* Frames are captured on demand and pushed into the attachment pipeline. */

import { useEffect } from 'react';
import { Camera, Loader2, Square, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCameraCapture } from '@/sections/chat/hooks/useCameraCapture';
import type { AnchorPos } from './useComposerPopovers';

export function CameraPopover({
  open,
  pos,
  onClose,
  onCapture,
}: {
  open: boolean;
  pos: AnchorPos | null;
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const { status, errorMessage, videoRef, start, stop, capture, capturing, isStreaming } =
    useCameraCapture();

  // Close on Escape; stop the stream whenever the popover hides.
  useEffect(() => {
    if (!open) {
      stop();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, stop]);

  if (!open || !pos) return null;

  const handleCapture = () => {
    void capture((file) => onCapture(file));
  };

  return (
    <div
      data-composer-popover
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        transform: 'translateY(-100%)',
      }}
      className="z-50 w-72 bg-card border border-border rounded-xl shadow-2xl p-3 space-y-2"
      data-testid="composer-camera-popover"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Camera className="size-3.5 text-muted-foreground" />
          Camera
          {isStreaming && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-success/15 text-success px-1.5 py-0.5 text-[9px] font-medium border border-success/20"
              data-testid="composer-camera-active-badge"
            >
              <CircleDot className="size-2.5" /> live
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-muted-foreground hover:text-foreground"
          aria-label="Close camera"
        >
          Esc
        </button>
      </div>

      <div
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-lg border border-border/60 bg-muted/60',
          'flex items-center justify-center',
        )}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn('size-full object-cover', !isStreaming && 'hidden')}
        />
        {status === 'idle' && (
          <div className="text-center px-3">
            <Camera className="size-5 text-muted-foreground/60 mx-auto" />
            <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug">
              Click Start to enable the webcam. Frames stay on this device — nothing is uploaded
              until you capture and send.
            </p>
          </div>
        )}
        {status === 'requesting' && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            requesting camera…
          </div>
        )}
        {(status === 'error' || status === 'denied') && (
          <div className="text-center px-3">
            <p className="text-[10px] text-warning leading-snug">
              {errorMessage || 'Camera unavailable.'}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {!isStreaming ? (
          <button
            type="button"
            onClick={() => void start()}
            disabled={status === 'requesting'}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-2 py-1.5 text-xs hover:bg-primary/90 disabled:opacity-40"
          >
            {status === 'requesting' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Camera className="size-3" />
            )}
            {status === 'requesting' ? 'Starting…' : 'Start'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleCapture}
              disabled={capturing}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-2 py-1.5 text-xs hover:bg-primary/90 disabled:opacity-40"
              data-testid="composer-camera-capture"
            >
              {capturing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Camera className="size-3" />
              )}
              Capture
            </button>
            <button
              type="button"
              onClick={stop}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-foreground/10 px-2 py-1.5 text-xs hover:bg-foreground/15"
              title="Stop the camera stream"
            >
              <Square className="size-3" />
              Stop
            </button>
          </>
        )}
      </div>
    </div>
  );
}
