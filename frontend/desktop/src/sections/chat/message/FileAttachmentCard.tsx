/* ── File attachment card (chat bubble) ─────────────────────────────── */
/* Compact document/image preview matching product reference: thumbnail  */
/* page, type badge, optional size — not the raw model prompt dump.      */

import { getFileIcon } from '@/lib/file-icon';
import { cn } from '@/lib/utils';
import type { FileAttachment } from '@/types/chat';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { useLayoutEffect, useRef, useState } from 'react';

function extensionLabel(name: string): string {
  const ext = name.split('.').pop()?.toUpperCase();
  if (!ext || ext.length > 5) return 'FILE';
  return ext;
}

export function FileAttachmentCard({
  file,
  className,
}: {
  file: FileAttachment;
  className?: string;
}) {
  const thumb = file.thumbnailUrl || (file.type === 'image' ? file.dataUrl || file.previewUrl : undefined);
  const isImage = file.type === 'image' && !!thumb;
  const fi = getFileIcon(file.name);
  const Icon = fi.Icon;
  const badge = extensionLabel(file.name);
  const canOpen = (file.status ?? 'ready') === 'ready';
  const [ratio, setRatio] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // The ratio is a measurement, not a style decision, so it lands as a CSS
  // variable instead of a JSX style object: that object was the only violation
  // `check:design` reported in the tree, and the variable keeps the box's shape
  // in the stylesheet where the utilities live
  // (`aspect-[var(--attach-ratio,3/4)]`) — the same mechanism as PdfPager's
  // `--pdf-page-ratio`. A layout effect rather than a render-time write, because
  // the box only exists after mount. (Do not spell the banned JSX form in this
  // comment: the gate's regex matches the text, not the syntax.)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (ratio && ratio > 0) el.style.setProperty('--attach-ratio', String(ratio));
    else el.style.removeProperty('--attach-ratio');
  }, [ratio]);

  return (
    <button
      type="button"
      onClick={() => {
        if (canOpen) openRightDrawerFile(file);
      }}
      disabled={!canOpen}
      className={cn(
        'group relative w-[148px] overflow-hidden rounded-lg border border-border/70 bg-muted/40 text-left shadow-sm transition',
        'ring-1 ring-black/5',
        canOpen
          ? 'cursor-pointer hover:border-primary/60 hover:ring-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
          : 'cursor-default opacity-80',
        className,
      )}
      title={canOpen ? `Open ${file.name} in preview` : file.name}
      aria-label={canOpen ? `Open ${file.name} in preview` : file.name}
    >
      {/* The box takes the media's own ratio once it loads.
          It used to be a fixed `aspect-[3/4]` with `object-cover`, which is a
          portrait frame: `renderPdfThumbnail` rasterises the page at its native
          MediaBox aspect (file-reader.ts:149-151), so a landscape page arrived
          as ~160x113 and was scaled to cover 148x197 — losing about 47% of the
          page width on each side. A wide diagram rendered as an unreadable
          centre strip. `object-contain` covers the frame before the ratio is
          known, so nothing is cropped in either state. */}
      <div
        ref={boxRef}
        className="relative flex max-h-[220px] min-h-[72px] w-full items-center justify-center bg-[#1a1a1c] aspect-[var(--attach-ratio,3/4)]"
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            ref={(el) => {
              // A data-URL thumbnail can finish decoding before React attaches
              // `onLoad`, and then the event never comes — measured in Chromium,
              // where the frame stayed portrait despite naturalWidth 210. The
              // already-complete case is read here as well as on load.
              if (el && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
                setRatio(el.naturalWidth / el.naturalHeight);
              }
            }}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) setRatio(w / h);
            }}
            className={cn('h-full w-full object-contain', !isImage && 'bg-white')}
            draggable={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-muted/80 to-muted/40 px-3">
            <Icon size={28} color={fi.color} />
            <span className="line-clamp-2 text-center text-2xs font-medium text-foreground/80">
              {file.name}
            </span>
          </div>
        )}

        {/* Type badge — bottom-left (PDF / DOC / …) */}
        <span
          className="absolute bottom-1.5 left-1.5 rounded bg-zinc-800/90 px-1.5 py-0.5 text-2xs font-bold tracking-wide text-zinc-100 shadow-sm"
        >
          {badge}
        </span>

        {/* Size — bottom-right */}
        {file.size ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-zinc-200">
            {file.size}
          </span>
        ) : null}
      </div>
    </button>
  );
}

export function FileAttachmentCardRow({
  attachments,
}: {
  attachments: FileAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-start justify-end gap-2">
      {attachments.map((a, i) => (
        <FileAttachmentCard key={a.id ?? `${a.name}-${i}`} file={a} />
      ))}
    </div>
  );
}
