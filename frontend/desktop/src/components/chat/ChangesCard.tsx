/* ── ChangesCard ─ unified ZCode-style turn changes card (plan §4.5) ─ */
/* Replaces ChangedFilesCard + ProducedFilesRow with one aggregate card:    */
/* `X files changed +N −M [Undo]` header expanding to type-aware rows —     */
/* code rows (FileIcon + ±chips + Review + Open, collapsible inline diff)   */
/* and document rows (56×56 letter badge + kind label + Open). Always       */
/* visible once an edit tool ran, including while streaming.                */

import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/ui/FileIcon';
import { DiffView } from '@/components/chat/DiffView';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { DocumentBadge } from '@/components/chat/DocumentBadge';
import { classifyFileKind, openFileInDrawer, type FileKindInfo } from '@/lib/file-kind';
import { collectProducedFiles, producedFileLabel } from '@/lib/produced-files';
import { useRevertAllChanges } from '@/lib/git-revert';
import { openRightDrawer, setRightDrawerDiff } from '@/components/shell/RightDrawerState';
import type { GitDiffFile, GitDiffResult } from '@/api/git';
import type { MessageBlock } from '@/types/chat';

const MAX_ROWS = 8;

export function ChangesCard({
  blocks,
  changedFiles,
  sessionId,
  onReview,
  onOpen,
  className,
}: {
  /** Turn tool-call blocks — always available; powers the file list. */
  blocks?: MessageBlock[] | null;
  /** Optional post-turn git diff; enriches rows with ±counts and diff text. */
  changedFiles?: GitDiffResult | null;
  /** Owning session (Undo target). Falls back to the `/c/:sessionId` route. */
  sessionId?: string | null;
  /** Override the default Review action (open diff in right drawer). */
  onReview?: (path: string) => void;
  /** Override the default Open action (right-drawer file viewer). */
  onOpen?: (path: string) => void;
  className?: string;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const effectiveSessionId = sessionId ?? routeSessionId ?? null;

  const paths = useMemo(() => {
    const produced = collectProducedFiles(blocks);
    if (produced.length > 0) return produced;
    // Git saw changes no edit tool carried paths for (e.g. a script ran in
    // the sandbox) — keep the aggregate + Undo usable from the diff alone.
    return (changedFiles?.files ?? []).map((f) => f.path);
  }, [blocks, changedFiles]);

  const diffMap = useMemo(() => {
    const m = new Map<string, GitDiffFile>();
    for (const f of changedFiles?.files ?? []) m.set(f.path, f);
    return m;
  }, [changedFiles]);

  // Totals come only from the git diff; omitted entirely until it lands.
  const totals = useMemo(() => {
    const files = changedFiles?.files ?? [];
    return {
      added: files.reduce((sum, f) => sum + f.added, 0),
      removed: files.reduce((sum, f) => sum + f.removed, 0),
    };
  }, [changedFiles]);

  // Default open state follows the reference: small change sets show their
  // rows immediately, large ones stay collapsed. Only a user toggle sticks.
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? paths.length <= 3;
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const { revertAll, reverting, confirmDialog } = useRevertAllChanges(
    effectiveSessionId,
    paths.length,
  );

  if (paths.length === 0) return null;

  const visible = paths.slice(0, MAX_ROWS);
  const overflow = paths.length - visible.length;
  const hasTotals = totals.added > 0 || totals.removed > 0;

  const handleReview = (path: string) => {
    if (onReview) return onReview(path);
    if (!changedFiles) return;
    setRightDrawerDiff(changedFiles, path);
    openRightDrawer('diff');
  };

  const handleOpen = async (path: string) => {
    if (busyPath) return;
    if (onOpen) return onOpen(path);
    setBusyPath(path);
    try {
      await openFileInDrawer(path, effectiveSessionId ?? undefined);
    } finally {
      setBusyPath(null);
    }
  };

  const toggleFileDiff = (path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div
      className={cn(
        'mt-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.025] shadow-sm',
        className,
      )}
      data-slot="changes-card"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpandedOverride(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
          data-testid="changes-card-header"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0 text-[11.5px] text-foreground/85">
            <span className="font-medium">{paths.length}</span>
            <span className="text-muted-foreground/70">
              {' '}file{paths.length === 1 ? '' : 's'} changed
            </span>
          </span>
          {hasTotals && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
              {totals.added > 0 && (
                <span className="text-success" data-testid="changes-card-added">
                  +{totals.added} added
                </span>
              )}
              {totals.removed > 0 && (
                <span className="text-rose-400" data-testid="changes-card-removed">
                  -{totals.removed} removed
                </span>
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            revertAll();
          }}
          disabled={reverting}
          title="Revert all changes from this turn"
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:opacity-50"
          data-testid="changes-card-undo"
        >
          {reverting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Undo2 className="size-3" />
          )}
          Undo
        </button>
      </div>

      {expanded && (
        <div className="space-y-1.5 border-t border-white/[0.045] px-3 py-2">
          {visible.map((path) => {
            const hit = diffMap.get(path);
            const info = classifyFileKind(path);
            const isCodeRow = info.kind === 'code' && !!hit;
            return isCodeRow ? (
              <CodeFileRow
                key={path}
                path={path}
                file={hit}
                diffOpen={expandedFiles.has(path)}
                onToggleDiff={() => toggleFileDiff(path)}
                onReview={() => handleReview(path)}
                onOpen={() => void handleOpen(path)}
                busy={busyPath === path}
              />
            ) : (
              <DocumentFileRow
                key={path}
                path={path}
                info={info}
                onOpen={() => void handleOpen(path)}
                busy={busyPath === path}
              />
            );
          })}
          {overflow > 0 && (
            <div
              className="px-0.5 text-[10px] text-muted-foreground/60"
              data-testid="changes-card-overflow"
            >
              +{overflow} more
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

/* Code row: FileIcon + path + per-file ±chips + Review + Open; the path
   area toggles a capped inline diff (collapsed by default — the timeline's
   edit rows already carry the in-flow detail). */
function CodeFileRow({
  path,
  file,
  diffOpen,
  onToggleDiff,
  onReview,
  onOpen,
  busy,
}: {
  path: string;
  file: GitDiffFile;
  diffOpen: boolean;
  onToggleDiff: () => void;
  onReview: () => void;
  onOpen: () => void;
  busy: boolean;
}) {
  const hasDiff = Boolean(file.diff && file.diff.trim());
  return (
    <div className="min-w-0" data-testid="changes-card-row" data-style="code" data-kind="code">
      <div className="flex items-center gap-1.5">
        <DisclosureRow
          open={diffOpen && hasDiff}
          onToggle={hasDiff ? onToggleDiff : undefined}
          trailing={
            <span className="font-mono text-[10px] tabular-nums">
              {file.added > 0 && <span className="text-success">+{file.added}</span>}{' '}
              {file.removed > 0 && <span className="text-rose-400">-{file.removed}</span>}
              {file.added === 0 && file.removed === 0 && (
                <span className="text-muted-foreground/50">0</span>
              )}
            </span>
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon name={path} size={13} className="shrink-0" />
            <span className="truncate font-mono text-[10.5px] text-foreground/85" title={path}>
              {path}
            </span>
          </span>
        </DisclosureRow>
        {hasDiff && (
          <button
            type="button"
            onClick={onReview}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground"
            title="Open full diff in drawer"
            data-testid="changes-card-review"
          >
            Review
          </button>
        )}
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground disabled:opacity-50"
          title="Open file in side panel"
          data-testid="changes-card-open"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : 'Open'}
        </button>
      </div>
      {diffOpen && hasDiff && (
        <div className="pl-4 pr-1 pt-0.5" data-testid="changes-card-inline-diff">
          <DiffView diff={file.diff} maxLines={32} />
        </div>
      )}
    </div>
  );
}

/* Document row: big letter badge + filename + kind label + single Open ▾.
   Row click and the Open button are the same action; the chevron is a visual
   affordance only (matches the reference), not a dropdown. */
function DocumentFileRow({
  path,
  info,
  onOpen,
  busy,
}: {
  path: string;
  info: FileKindInfo;
  onOpen: () => void;
  busy: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5"
      data-testid="changes-card-row"
      data-style="document"
      data-kind={info.kind}
    >
      <DocumentBadge text={info.badgeText} tone={info.badgeTone} />
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        title={`Open in side panel — ${path}`}
        className="min-w-0 flex-1 text-left disabled:opacity-50"
      >
        <span className="block truncate text-[12.5px] font-medium text-foreground">
          {producedFileLabel(path)}
        </span>
        <span className="block truncate text-[10.5px] text-muted-foreground">{info.label}</span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 px-2 py-1 text-[10.5px] text-muted-foreground transition hover:bg-white/[0.05] hover:text-foreground disabled:opacity-50"
        title="Open file in side panel"
        data-testid="changes-card-open"
      >
        Open
        <ChevronDown className="size-3" />
      </button>
    </div>
  );
}
