/* ── File attachment card (chat bubble) ─────────────────────────────── */
/* Compact document/image preview matching product reference: thumbnail  */
/* page, type badge, optional size — not the raw model prompt dump.      */

import { getFileIcon } from '@/lib/file-icon';
import { cn } from '@/lib/utils';
import type { FileAttachment } from '@/types/chat';

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
  const isPdf = /\.pdf$/i.test(file.name) || file.name.toLowerCase().endsWith('.pdf');
  const fi = getFileIcon(file.name);
  const Icon = fi.Icon;
  const badge = extensionLabel(file.name);

  return (
    <div
      className={cn(
        'relative w-[148px] overflow-hidden rounded-lg border border-border/70 bg-muted/40 shadow-sm',
        'ring-1 ring-black/5',
        className,
      )}
      title={file.name}
    >
      <div className="relative aspect-[3/4] w-full bg-[#1a1a1c]">
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className={cn(
              'h-full w-full',
              isImage ? 'object-cover' : 'object-cover object-top bg-white',
            )}
            draggable={false}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-muted/80 to-muted/40 px-3">
            <Icon size={28} color={fi.color} />
            <span className="line-clamp-2 text-center text-[10px] font-medium text-foreground/80">
              {file.name}
            </span>
          </div>
        )}

        {/* Type badge — bottom-left (PDF / DOC / …) */}
        <span
          className={cn(
            'absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide shadow-sm',
            isPdf
              ? 'bg-zinc-800/90 text-zinc-100'
              : 'bg-zinc-800/90 text-zinc-100',
          )}
        >
          {badge}
        </span>

        {/* Size — bottom-right */}
        {file.size ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-zinc-200">
            {file.size}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function FileAttachmentCardRow({
  attachments,
}: {
  attachments: FileAttachment[];
}) {
  if (!attachments.length) return null;
  return (
    <div className="mb-2 flex flex-wrap justify-end gap-2">
      {attachments.map((a, i) => (
        <FileAttachmentCard key={a.id ?? `${a.name}-${i}`} file={a} />
      ))}
    </div>
  );
}
