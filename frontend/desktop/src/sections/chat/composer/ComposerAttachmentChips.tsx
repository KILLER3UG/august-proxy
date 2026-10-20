/* ── Attachment chips ──────────────────────────────────────────────────── */
/* Modern pending-file cards: circular progress while reading, then a      */
/* thumbnail (images) or type icon (pdf/doc/txt/…) once ready.              */
/*                                                                          */
/* The strip used to be a FILLED BAND (`bg-muted/15` + a bottom border)      */
/* holding N separate BORDERED CARDS with their own shadows — three border  */
/* levels for what is a list of pending files. The capture's rule is the    */
/* opposite: "Borders are hairlines, never boxes. Where something needs      */
/* containment it is one rounded container with hairline children, not N      */
/* bordered cards", and the elevated surfaces in the reference set are FILLS  */
/* ("the elevated surfaces — user bubble, selected row, input field — sit at */
/* a grey band well above the page background"). So the band is gone and the chips are fills      */
/* separated by a gap: no boxes where a gap will do.                         */

import type { ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getFileIcon } from '@/lib/file-icon';
import { ProgressRing } from '@/lib/icons';
import type { FileAttachment } from '@/types/chat';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';

const RING_SIZE = 44;

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
      <ProgressRing
        size={RING_SIZE}
        progress={determinate ? pct : undefined}
        style={determinate ? undefined : { animationDuration: '0.9s' }}
      />
      <div className="absolute inset-[5px] flex items-center justify-center overflow-hidden rounded-full bg-muted/80">
        {children ?? (
          <span className="text-2xs font-semibold tabular-nums text-foreground/80">
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
        className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-destructive/10"
        title={file.error || 'Failed to read file'}
      >
        <AlertCircle className="size-4 text-destructive" />
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="size-11 shrink-0 overflow-hidden rounded-lg bg-muted">
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
      <div className="relative size-11 shrink-0 overflow-hidden rounded-lg bg-white">
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
    <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted/70">
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
    <div
      className="flex flex-wrap gap-1.5 px-2 pt-2"
      data-testid="composer-attachment-strip"
    >
      {attachments.map((file, i) => {
        const status = file.status ?? 'ready';
        const progress = file.progress ?? 0;
        const isReading = status === 'reading';
        const canOpen = status === 'ready';

        return (
          <div
            key={file.id ?? `${file.name}-${i}`}
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            onClick={() => {
              if (canOpen) openRightDrawerFile(file);
            }}
            onKeyDown={(event) => {
              if (canOpen && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                openRightDrawerFile(file);
              }
            }}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-lg pl-1.5 pr-2 py-1.5',
              'bg-muted/40 transition-colors',
              'max-w-[220px] animate-in fade-in zoom-in-95 duration-150',
              canOpen && 'cursor-pointer hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              status === 'error' && 'bg-destructive/10',
            )}
            title={canOpen ? `Open ${file.name} in preview` : file.name}
            aria-label={canOpen ? `Open ${file.name} in preview` : undefined}
          >
            <AttachmentThumb file={file} />

            <div className="min-w-0 flex-1 pr-4">
              <div className="text-2xs font-medium truncate text-foreground leading-tight">
                {file.name}
              </div>
              <div className="text-2xs text-muted-foreground tabular-nums mt-0.5">
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
              onClick={(event) => {
                event.stopPropagation();
                onRemove(i);
              }}
              className={cn(
                'absolute top-1 right-1 p-0.5 rounded-full',
                'bg-background/80',
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
