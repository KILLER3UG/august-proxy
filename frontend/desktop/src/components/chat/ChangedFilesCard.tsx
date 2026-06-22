/* ── ChangedFilesCard ─ inline post-turn mutation summary ─────────── */
/* Mirrors the ZCode-style “2 files changed +27 -12” summary after a      */
/* Workbench turn that edited files. Keeps diffs collapsible so the chat   */
/* stays scannable while still surfacing the concrete file changes.        */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/ui/FileIcon';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { DiffView } from '@/components/chat/DiffView';
import { openRightDrawer, setRightDrawerDiff } from '@/components/shell/RightDrawerState';
import type { GitDiffResult } from '@/api/git';

export function ChangedFilesCard({
  changes,
  className,
}: {
  changes: GitDiffResult;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const files = changes.files.filter(file => file.added > 0 || file.removed > 0 || file.status);

  if (files.length === 0) return null;

  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  return (
    <div
      className={cn(
        'mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.025]',
        'shadow-sm overflow-hidden',
        className
      )}
      data-slot="changed-files-card"
    >
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/[0.035] transition-colors"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
            Changed files
          </div>
          <div className="mt-0.5 text-[11.5px] text-foreground/85">
            <span className="font-medium">{files.length}</span>
            <span className="text-muted-foreground/70"> file{files.length === 1 ? '' : 's'} changed</span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
          {added > 0 && <span className="text-success">+{added}</span>}
          {removed > 0 && <span className="text-rose-400">-{removed}</span>}
          {added === 0 && removed === 0 && <span className="text-muted-foreground/60">0</span>}
        </div>
      </button>

      {open && (
        <div className="border-t border-white/[0.045] px-3 py-2 space-y-1.5">
          {files.map((file) => (
            <ChangedFileRow key={file.path} changes={changes} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangedFileRow({
  changes,
  file,
}: {
  changes: GitDiffResult;
  file: GitDiffResult['files'][number];
}) {
  const [open, setOpen] = useState(false);
  const hasDiff = Boolean(file.diff && file.diff.trim());

  const openInDrawer = () => {
    setRightDrawerDiff(changes, file.path);
    openRightDrawer('diff');
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <DisclosureRow
          open={open && hasDiff}
          onToggle={hasDiff ? () => setOpen(value => !value) : undefined}
          trailing={
            <span className="font-mono text-[10px] tabular-nums">
              {file.added > 0 && <span className="text-success">+{file.added}</span>}
              {' '}
              {file.removed > 0 && <span className="text-rose-400">-{file.removed}</span>}
              {file.added === 0 && file.removed === 0 && <span className="text-muted-foreground/50">0</span>}
            </span>
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon name={file.path} size={13} className="shrink-0" />
            <span className="truncate font-mono text-[10.5px] text-foreground/85" title={file.path}>
              {file.path}
            </span>
          </span>
        </DisclosureRow>
        <button
          type="button"
          onClick={openInDrawer}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground transition"
          title="Open full diff in drawer"
        >
          Open
        </button>
      </div>
      {open && hasDiff && (
        <div className="pl-4 pr-1 pt-0.5">
          <DiffView diff={file.diff} maxLines={32} />
        </div>
      )}
    </div>
  );
}
