/* ── ChangesCard ─ unified ZCode-style turn changes card ─ */
/* Replaces ChangedFilesCard + ProducedFilesRow with one aggregate card:    */
/* `X files changed +N −M [Undo]` header expanding to type-aware rows —     */
/* code rows (FileIcon + ±chips + Review + Open, collapsible inline diff).   */
/* A DOCUMENT is not a change - it has no diff - and the artifact card owns */
/* it, so this card lists code only. Always visible once an edit tool ran,  */
/* including while streaming.                                                */

import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/components/ui/FileIcon';
import { DiffView } from '@/components/chat/DiffView';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { classifyFileKind, openFileInDrawer } from '@/lib/file-kind';
import { collectProducedFiles } from '@/lib/produced-files';
import {
  artifactOwnedPaths,
  type ProducedToolEntry,
} from '@/lib/produced-artifacts';
import { useRevertAllChanges } from '@/lib/git-revert';
import { openRightDrawer, setRightDrawerDiff } from '@/components/shell/RightDrawerState';
import type { GitDiffFile, GitDiffResult } from '@/api/git';
import type { MessageBlock } from '@/types/chat';

const MAX_ROWS = 8;

export function ChangesCard({
  blocks,
  tools,
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
  /** The turn's tool entries - the result side of the artifact rule. */
  tools?: ProducedToolEntry[] | null;
  /** Override the default Review action (open diff in right drawer). */
  onReview?: (path: string) => void;
  /** Override the default Open action (right-drawer file viewer). */
  onOpen?: (path: string) => void;
  className?: string;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const effectiveSessionId = sessionId ?? routeSessionId ?? null;

  /* The files the artifact card owns - one rule, so the two cards cannot
     disagree about who shows a file. */
  const artifactOwned = useMemo(
    () => artifactOwnedPaths(blocks, tools),
    [blocks, tools],
  );

  const paths = useMemo(() => {
    const produced = collectProducedFiles(blocks);
    if (produced.length > 0) return produced;
    // Git saw changes no edit tool carried paths for (e.g. a script ran in
    // the sandbox) — keep the aggregate + Undo usable from the diff alone.
    return (changedFiles?.files ?? []).map((f) => f.path);
  }, [blocks, changedFiles]);

  /* The files this card LISTS: the ones it owns. A file the artifact
     card owns - a document, an image, or a source file the turn CREATED -
     is not a row here, so the count in the header has to count the same
     set. A header that said "2 files changed" above an empty list was
     worse than no header at all. */
  const diffMap = useMemo(() => {
    const m = new Map<string, GitDiffFile>();
    for (const f of changedFiles?.files ?? []) {
      m.set(f.path, f);
      m.set(f.path.replace(/\\/g, '/'), f);
    }
    return m;
  }, [changedFiles]);

  const ownedPaths = useMemo(
    () =>
      paths.filter((p) => {
        const normalized = p.replace(/\\/g, '/').toLowerCase();
        // A path git reports as changed is a diff, even when the tool that
        // wrote it was `write_file` (which the artifact card otherwise treats
        // as a create). Hiding the diff of an overwritten source file was the
        // artifact card owning a change it did not create.
        if (diffMap.has(p) || diffMap.has(p.replace(/\\/g, '/'))) return true;
        return !artifactOwned.has(normalized);
      }),
    [paths, artifactOwned, diffMap],
  );

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
  const expanded = expandedOverride ?? ownedPaths.length <= 3;
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const { revertAll, reverting, confirmDialog } = useRevertAllChanges(
    effectiveSessionId,
    paths.length,
  );

  if (paths.length === 0) return null;

  const visible = ownedPaths.slice(0, MAX_ROWS);
  const overflow = ownedPaths.length - visible.length;
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
        'mt-3 overflow-hidden rounded-2xl border border-border/40 bg-card/30 shadow-xs',
        className,
      )}
      data-slot="changes-card"
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setExpandedOverride(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
          data-testid="changes-card-header"
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}
          {ownedPaths.length > 0 ? (
            <span className="shrink-0 text-2xs text-foreground/85">
              <span className="font-medium">{ownedPaths.length}</span>
              <span className="text-muted-foreground/70">
                {' '}file{ownedPaths.length === 1 ? '' : 's'} changed
              </span>
            </span>
          ) : null}
          {hasTotals && (
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums">
              {totals.added > 0 && (
                <span className="text-success" data-testid="changes-card-added">
                  +{totals.added} added
                </span>
              )}
              {totals.removed > 0 && (
                <span className="text-danger-fg" data-testid="changes-card-removed">
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
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/40 bg-background/50 px-2 py-0.5 text-2xs font-medium text-muted-foreground transition hover:border-border hover:bg-background hover:text-foreground disabled:opacity-50"
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
        <div className="space-y-1.5 border-t border-border/50 px-3 py-2">
          {visible.map((path) => {
            const hit = diffMap.get(path);
            const info = classifyFileKind(path);
            const isCodeRow = info.kind === 'code' && !!hit;
            /* A file the ARTIFACT card owns is not a row here. It is
             * either not a source file (a document, an image - it has no
             * diff to show) or a source file the turn CREATED (a deliverable
             * the user asked for). Either way the artifact card lists it
             * with its kind and a Download, and showing it here too put the
             * same file on the transcript twice, in two shapes. This card
             * is the diff list. */
            if (!isCodeRow) return null;
            if (artifactOwned.has(path.replace(/\\/g, '/').toLowerCase())) return null;
            return (
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
            );
          })}
          {overflow > 0 && (
            <div
              className="px-0.5 text-2xs text-muted-foreground/60"
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
    <div className="min-w-0 rounded-xl px-2 py-1.5 transition-colors" data-testid="changes-card-row" data-style="code" data-kind="code">
      <div className="flex items-center gap-1.5">
        <DisclosureRow
          open={diffOpen && hasDiff}
          onToggle={hasDiff ? onToggleDiff : undefined}
          trailing={
            <span className="font-mono text-2xs tabular-nums">
              {file.added > 0 && <span className="text-success">+{file.added}</span>}{' '}
              {file.removed > 0 && <span className="text-danger-fg">-{file.removed}</span>}
              {file.added === 0 && file.removed === 0 && (
                <span className="text-muted-foreground/50">0</span>
              )}
            </span>
          }
          /* The body belongs to the disclosure, not to a sibling the trigger
             knows nothing about: this is the last of the five `DisclosureRow`
             call sites, and the other four pass their body this way. The
             trigger then advertises a real `aria-controls` and the body a real
             hidden state, in BOTH states — the closed row is the one a screen
             reader navigates.

             A row with no diff passes `undefined` and gets no region at all
             (the established pattern: `tool/ToolCallItem.tsx`). The body is
             mounted whether the row is open or closed, which is what
             `forceMount` means; `DiffView` measures nothing, so a hidden
             region renders it exactly as a visible one would. */
          content={
            hasDiff ? (
              <div className="pl-4 pr-1 pt-1.5" data-testid="changes-card-inline-diff">
                <DiffView diff={file.diff} maxLines={32} />
              </div>
            ) : undefined
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon name={path} size={13} className="shrink-0" />
            <span className="truncate font-mono text-2xs text-foreground/85" title={path}>
              {path}
            </span>
          </span>
        </DisclosureRow>
        {hasDiff && (
          <button
            type="button"
            onClick={onReview}
            className="shrink-0 rounded-md border border-border/50 bg-background/50 px-2 py-0.5 text-2xs font-medium text-muted-foreground transition hover:border-border hover:bg-background hover:text-foreground"
            title="Open full diff in drawer" aria-label="Open full diff in drawer"
            data-testid="changes-card-review"
          >
            Review
          </button>
        )}
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="shrink-0 rounded-md border border-border/50 bg-background/50 px-2 py-0.5 text-2xs font-medium text-muted-foreground transition hover:border-border hover:bg-background hover:text-foreground disabled:opacity-50"
          title="Open file in side panel" aria-label="Open file in side panel"
          data-testid="changes-card-open"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : 'Open'}
        </button>
      </div>
    </div>
  );
}
