/* ── ProducedFilesRow ─ light "Files touched" chips for a turn ────── */
/*                                                                        */
/* Quiet deliverables row (dsh-style): derived from the turn's edit tool  */
/* calls, each chip opens the file in the right-drawer viewer; a single   */
/* "Show in folder" action reveals the first file in the OS file manager. */

import { useMemo, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { FileIcon } from '@/components/ui/FileIcon';
import { collectProducedFiles, producedFileLabel } from '@/lib/produced-files';
import { openRightDrawerFile } from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';
import { toast } from 'sonner';
import type { MessageBlock } from '@/types/chat';

const MAX_CHIPS = 6;

export function ProducedFilesRow({
  blocks,
  className,
}: {
  blocks?: MessageBlock[] | null;
  className?: string;
}) {
  const files = useMemo(() => collectProducedFiles(blocks), [blocks]);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  if (files.length === 0) return null;

  const visible = files.slice(0, MAX_CHIPS);
  const overflow = files.length - visible.length;

  const openFile = async (path: string) => {
    if (busyPath) return;
    setBusyPath(path);
    try {
      const attachment = await ChatAttachmentService.fromPath(path);
      if (attachment) {
        // Claude-style: deliverable cards open in the RIGHT SIDEBAR panel.
        openRightDrawerFile(attachment);
      } else {
        await revealInFolder(path);
      }
    } catch (err) {
      toast.error('Could not open file');
      console.warn('[ProducedFilesRow] open failed:', err);
    } finally {
      setBusyPath(null);
    }
  };

  const kindLabel = (path: string): string => {
    const ext = path.replace(/\\/g, '/').split('.').pop()?.toUpperCase() ?? '';
    if (!ext) return 'File';
    if (ext === 'PPTX') return 'Presentation · PPTX';
    if (ext === 'DOCX') return 'Document · DOCX';
    if (ext === 'XLSX') return 'Spreadsheet · XLSX';
    if (['PNG', 'JPG', 'JPEG', 'SVG', 'WEBP', 'GIF'].includes(ext)) return `Image · ${ext}`;
    if (['MP4', 'MOV', 'WEBM', 'AVI', 'MKV'].includes(ext)) return `Video · ${ext}`;
    if (ext === 'PDF') return 'PDF';
    return ext;
  };

  const showInFolder = async () => {
    if (busyPath || files.length === 0) return;
    setBusyPath(files[0]);
    try {
      await revealInFolder(files[0]);
    } catch (err) {
      toast.error('Could not reveal in folder');
      console.warn('[ProducedFilesRow] reveal failed:', err);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className={className} data-slot="produced-files-row">
      <div className="mt-2.5 flex flex-wrap items-stretch gap-2">
        <span className="mr-0.5 self-center text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold">
          Files created
        </span>
        {visible.map((path) => (
          <button
            key={path}
            type="button"
            onClick={() => void openFile(path)}
            disabled={busyPath === path}
            title={`Open in side panel — ${path}`}
            className="group flex min-w-[180px] max-w-[260px] items-center gap-2.5 rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-left transition hover:border-primary/40 hover:bg-card cursor-pointer"
          >
            {busyPath === path ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/50">
                <FileIcon name={path} size={15} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-foreground">
                {producedFileLabel(path)}
              </span>
              <span className="block truncate text-[10.5px] text-muted-foreground">
                {kindLabel(path)}
              </span>
            </span>
          </button>
        ))}
        {overflow > 0 && (
          <span className="self-center px-0.5 text-[10px] text-muted-foreground/60">+{overflow} more</span>
        )}
        <button
          type="button"
          onClick={() => void showInFolder()}
          disabled={!!busyPath}
          className="ml-1 self-center inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          {busyPath === files[0] ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : (
            <FolderOpen className="size-2.5" />
          )}
          Show in folder
        </button>
      </div>
    </div>
  );
}
