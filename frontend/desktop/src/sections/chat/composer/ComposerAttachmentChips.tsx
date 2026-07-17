/* ── Attachment chips ──────────────────────────────────────────────────── */
/* Modern pending-file cards: circular progress while reading, then a      */
/* thumbnail (images) or type icon (pdf/doc/txt/…) once ready.             */

import type { ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import type { FileAttachment } from '@/types/chat';

const RING_SIZE = 44;
const STROKE = 3;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function UploadProgressRing({
  progress,
  children,
  className,
}: {
  progress: number;
  children?: ReactNode;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, progress));
  // FileReader often skips progress events for small files — use an
  // indeterminate arc until we have a real percentage.
  const determinate = pct > 0;
  const offset = determinate ? CIRCUMFERENCE * (1 - pct / 100) : CIRCUMFERENCE * 0.75;

  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: RING_SIZE, height: RING_SIZE }}
      role="progressbar"
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={determinate ? `Uploading ${Math.round(pct)}%` : 'Uploading'}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        className={cn(
          'absolute inset-0 -rotate-90',
          !determinate && 'animate-spin',
        )}
        style={!determinate ? { animationDuration: '0.9s' } : undefined}
        aria-hidden
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-muted-foreground/25"
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={cn(
            'text-primary',
            determinate && 'transition-[stroke-dashoffset] duration-150 ease-out',
          )}
        />
      </svg>
      <div className="absolute inset-[5px] flex items-center justify-center overflow-hidden rounded-full bg-muted/80">
        {children ?? (
          <span className="text-[9px] font-semibold tabular-nums text-foreground/80">
            {determinate ? `${Math.round(pct)}%` : '…'}
          </span>
        )}
      </div>
    </div>
  );
}

function AttachmentThumb({ file }: { file: FileAttachment }) {
  const status = file.status ?? 'ready';
  const progress = file.progress ?? 0;
  const previewSrc = file.thumbnailUrl || file.dataUrl || file.previewUrl;
  const isImage = file.type === 'image' && !!(file.dataUrl || file.previewUrl);
  const isDocThumb = !!file.thumbnailUrl && !isImage;
  const fileIcon = getFileIcon(file.name);
  const IconComponent = fileIcon.Icon;

  if (status === 'reading') {
    return (
      <UploadProgressRing progress={progress}>
        {isImage ? (
          <img
            src={previewSrc}
            alt=""
            className="size-full object-cover opacity-60"
            draggable={false}
          />
        ) : (
          <IconComponent size={16} color={fileIcon.color} className="opacity-80" />
        )}
      </UploadProgressRing>
    );
  }

  if (status === 'error') {
    return (
      <div
        className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-destructive/10 border border-destructive/30"
        title={file.error || 'Failed to read file'}
      >
        <AlertCircle className="size-4 text-destructive" />
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="size-11 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
        <img
          src={previewSrc}
          alt={file.name}
          className="size-full object-cover"
          draggable={false}
        />
      </div>
    );
  }

  if (isDocThumb && previewSrc) {
    return (
      <div className="relative size-11 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-white">
        <img
          src={previewSrc}
          alt={file.name}
          className="size-full object-cover object-top"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/80">
      <IconComponent size={18} color={fileIcon.color} />
    </div>
  );
}

export function ComposerAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: FileAttachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 p-2.5 bg-muted/15 border-b border-border">
      {attachments.map((file, i) => {
        const status = file.status ?? 'ready';
        const progress = file.progress ?? 0;
        const isReading = status === 'reading';

        return (
          <div
            key={file.id ?? `${file.name}-${i}`}
            className={cn(
              'group relative flex items-center gap-2.5 pl-1.5 pr-2 py-1.5 rounded-xl',
              'bg-card border border-border shadow-xs',
              'max-w-[220px] animate-in fade-in zoom-in-95 duration-150',
              status === 'error' && 'border-destructive/40 bg-destructive/5',
            )}
          >
            <AttachmentThumb file={file} />

            <div className="min-w-0 flex-1 pr-4">
              <div className="text-[11px] font-medium truncate text-foreground leading-tight">
                {file.name}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                {isReading
                  ? progress > 0
                    ? `Uploading ${Math.round(progress)}%`
                    : 'Uploading…'
                  : status === 'error'
                    ? file.error || 'Failed'
                    : file.truncated
                      ? `${file.size} · truncated`
                      : file.size}
              </div>
            </div>

            <button
              type="button"
              onClick={() => onRemove(i)}
              className={cn(
                'absolute top-1 right-1 p-0.5 rounded-full',
                'bg-background/90 border border-border/60 shadow-xs',
                'text-muted-foreground hover:text-foreground hover:bg-muted',
                'opacity-0 group-hover:opacity-100 focus:opacity-100 transition',
              )}
              aria-label={`Remove ${file.name}`}
            >
              <X className="size-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
