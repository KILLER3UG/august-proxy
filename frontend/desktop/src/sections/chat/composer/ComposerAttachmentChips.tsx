/* ── Attachment chips ──────────────────────────────────────────────────── */
/* Horizontal row of pending file attachments above the composer textarea. */

import { X } from 'lucide-react';
import { getFileIcon } from '@/lib/file-icon';
import type { FileAttachment } from '@/types/chat';

export function ComposerAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: FileAttachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 p-2 bg-muted/20 border-b border-border">
      {attachments.map((file, i) => {
        const fileIcon = getFileIcon(file.name);
        const IconComponent = fileIcon.Icon;
        return (
          <div
            key={i}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted border border-border text-[10.5px]"
          >
            <IconComponent size={12} color={fileIcon.color} />
            <span className="font-mono truncate max-w-[150px]">{file.name}</span>
            <button
              onClick={() => onRemove(i)}
              className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-foreground transition"
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
