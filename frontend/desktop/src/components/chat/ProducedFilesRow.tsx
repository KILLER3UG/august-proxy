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
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold">
          Files touched
        </span>
        {visible.map((path) => (
          <button
            key={path}
            type="button"
            onClick={() => void openFile(path)}
            disabled={busyPath === path}
            title={path}
            className="group inline-flex max-w-52 items-center gap-1.5 rounded-md border border-border/60 bg-muted/25 px-1.5 py-0.5 text-[10.5px] text-foreground/75 transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {busyPath === path ? (
              <Loader2 className="size-2.5 animate-spin text-muted-foreground/60" />
            ) : (
              <FileIcon name={path} size={11} className="shrink-0" />
            )}
            <span className="truncate font-mono">{producedFileLabel(path)}</span>
          </button>
        ))}
        {overflow > 0 && (
          <span className="px-0.5 text-[10px] text-muted-foreground/60">+{overflow} more</span>
        )}
        <button
          type="button"
          onClick={() => void showInFolder()}
          disabled={!!busyPath}
          className="ml-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
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
