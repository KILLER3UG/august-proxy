/* ── WorkspaceChip — quiet folder selector in the composer footer ─────── */
/* 0.16.8: restores folder selection (the old boxed meta row was removed in
 * the minimalism pass) as a single muted chip: click → Tauri folder picker;
 * shows the current project folder name when bound, muted "Set folder"
 * otherwise. Sits next to the ContextRing so scope stays visible without
 * costing a whole bar. */

import { FolderOpen, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';

export function WorkspaceChip({
  workspacePath,
  className,
}: {
  workspacePath?: string | null;
  className?: string;
}) {
  const name = workspacePath
    ? workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath
    : '';

  const openPicker = () => {
    window.dispatchEvent(new CustomEvent('august:open-folder'));
  };

  return (
    <button
      type="button"
      onClick={openPicker}
      data-testid="workspace-chip"
      title={workspacePath ? `Working folder: ${workspacePath} (click to change)` : 'Choose the folder August works in'}
      className={cn(
        'inline-flex max-w-[11rem] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition-colors',
        workspacePath
          ? 'border-transparent bg-muted/30 text-foreground/70 hover:border-border hover:text-foreground'
          : 'border-dashed border-border/70 text-muted-foreground/70 hover:border-primary/40 hover:text-primary',
        className,
      )}
    >
      {workspacePath ? (
        <Folder className="size-3 shrink-0 opacity-60" />
      ) : (
        <FolderOpen className="size-3 shrink-0" />
      )}
      <span className="truncate">{name || 'Set folder'}</span>
    </button>
  );
}
