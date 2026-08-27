/* ── useCameraCapture ─────────────────────────────────────────────────── */
/* Webcam preview + manual snapshot. Captures a single frame on demand,    */
/* converts it to a File, and hands it to the composer attachment pipeline */
/* (useChatAttachments.attachFiles). The MediaStream is started/stopped by */
/* the consumer — frames are never persisted to disk.                     */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export type CameraStatus = 'idle' | 'requesting' | 'streaming' | 'error' | 'denied';

export interface UseCameraCaptureResult {
  /** Status the UI can show (badge / "Camera active" indicator). */
  status: CameraStatus;
  /** Error message when status === 'error' | 'denied'. */
  errorMessage: string | null;
  /** Attach a <video> element so the live preview can render the stream. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Begin streaming from the default video device. Idempotent. */
  start: () => Promise<void>;
  /** Stop the active stream and release the camera. Safe to call anytime. */
  stop: () => void;
  /** True while a frame is being drawn and encoded. */
  capturing: boolean;
  /** Capture a frame and push it through the given attach callback. */
  capture: (attach: (file: File) => void) => Promise<void>;
  /** True when the browser is currently streaming. */
  isStreaming: boolean;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const JPEG_QUALITY = 0.9;
const FILENAME_PREFIX = 'camera-capture-';

function pickVideoMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'image/jpeg';
  const candidates = ['image/jpeg', 'image/png', 'image/webp'];
  for (const type of candidates) {
    try {
      // Some browsers (Firefox) don't implement isTypeSupported on canvas; the
      // round-trip test below is cheap and well-supported.
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      const data = c.toDataURL(type);
      if (data && data.startsWith(`data:${type}`)) return type;
    } catch {
      /* try next */
    }
  }
  return 'image/jpeg';
}

export function useCameraCapture(): UseCameraCaptureResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const stop = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      try {
        s.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {
        /* ignore */
      }
    }
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  const start = useCallback(async () => {
    if (status === 'requesting' || status === 'streaming') return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setErrorMessage('Camera APIs are unavailable in this environment.');
      return;
    }
    setStatus('requesting');
    setErrorMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: DEFAULT_WIDTH },
          height: { ideal: DEFAULT_HEIGHT },
          facingMode: 'user',
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try {
          await videoRef.current.play();
        } catch {
          /* play() can reject if the element is detached; surface the
           * streaming state regardless since the MediaStream is live. */
        }
      }
      setStatus('streaming');
    } catch (err) {
      const e = err as DOMException | Error;
      const name = (e as DOMException).name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied');
        setErrorMessage('Camera access was denied. Allow camera permission to capture frames.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('error');
        setErrorMessage('No camera device was found on this machine.');
      } else {
        setStatus('error');
        setErrorMessage(e.message || 'Failed to start the camera.');
      }
    }
  }, [status]);

  const capture = useCallback(
    async (attach: (file: File) => void) => {
      if (status !== 'streaming') {
        toast.error('Start the camera preview first, then capture a frame.');
        return;
      }
      const video = videoRef.current;
      const stream = streamRef.current;
      if (!video || !stream) return;
      const track = stream.getVideoTracks()[0];
      if (!track) {
        toast.error('No active video track — restart the camera.');
        return;
      }
      setCapturing(true);
      try {
        // Use the track's intrinsic size when available; fall back to the
        // video element's displayed resolution.
        const settings = track.getSettings();
        const width = Math.round(settings.width ?? video.videoWidth ?? DEFAULT_WIDTH);
        const height = Math.round(settings.height ?? video.videoHeight ?? DEFAULT_HEIGHT);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          toast.error('Failed to allocate a 2D drawing context.');
          return;
        }
        ctx.drawImage(video, 0, 0, width, height);
        const mime = pickVideoMimeType();
        const blob: Blob | null = await new Promise((resolve) => {
          canvas.toBlob((b) => resolve(b), mime, JPEG_QUALITY);
        });
        if (!blob) {
          toast.error('Failed to encode the captured frame.');
          return;
        }
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        const filename = `${FILENAME_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        const file = new File([blob], filename, { type: mime });
        attach(file);
        toast.success('Camera frame attached');
      } finally {
        setCapturing(false);
      }
    },
    [status],
  );

  // Always release the camera on unmount — the user expects the green
  // "camera active" indicator to disappear when they close the popover.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    status,
    errorMessage,
    videoRef,
    start,
    stop,
    capturing,
    capture,
    isStreaming: status === 'streaming',
  };
}
