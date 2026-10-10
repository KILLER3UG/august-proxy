/* ── RightDrawerDiffSection ─ full diff view ──────────────────────── */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Copy, Loader2, RefreshCw, SearchCheck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gitApi } from '@/api/git';
import { codeReviewApi, type CodeReviewResult } from '@/api/codeReview';
import { DiffView } from '@/components/chat/DiffView';
import { FileIcon } from '@/components/ui/FileIcon';
import {
  useRightDrawer,
  closeRightDrawerSection,
  clearRightDrawerDiff,
  setRightDrawerDiff,
} from './RightDrawerState';
import { ReviewFindingsPanel } from './ReviewFindingsPanel';
import { useRevertAllChanges } from '@/lib/git-revert';

/** Stable DOM id prefix for a file's review anchors (DiffView scroll targets). */
function diffAnchorPrefix(path: string) {
  return `da-${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

function toggleIn(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

export function RightDrawerDiffSection({ sessionId }: { sessionId: string | null }) {
  const qc = useQueryClient();
  const drawer = useRightDrawer();
  const storedDiff = drawer.diff;
  // Files start collapsed past a couple of entries (a ten-file changeset used
  // to render as one endless scroll); ≤2 open so the common small diff still
  // reads at a glance.
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['git', 'diff', sessionId],
    queryFn: () => (sessionId ? gitApi.diff(sessionId) : Promise.resolve(null)),
    enabled: !!sessionId,
    retry: false,
  });

  const diff = query.data || storedDiff || undefined;
  const files = diff?.files?.filter((file) => file.added > 0 || file.removed > 0 || file.status || file.diff?.trim()) ?? [];
  // A two-file diff opens both; a bigger changeset opens the first two so the
  // list reads as a list (Hermes' review pane collapses files by default).
  const fileKeyList = files.map((f) => f.path).join('');
  useEffect(() => {
    setExpandedFiles(new Set(files.slice(0, 2).map((f) => f.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKeyList]);
  const added = diff?.added ?? files.reduce((sum, file) => sum + file.added, 0);
  const removed = diff?.removed ?? files.reduce((sum, file) => sum + file.removed, 0);

  // Shared with the chat ChangesCard Undo button: checkpoint
  // restore with a `git restore -- .` fallback, confirm dialog included.
  const { revertAll, reverting, confirmDialog } = useRevertAllChanges(
    sessionId,
    files.length,
    () => clearRightDrawerDiff(),
  );

  const refreshDiff = () => {
    void qc.invalidateQueries({ queryKey: ['git', 'diff', sessionId] });
  };

  /* Advisory code review of this changeset. The UI already
     holds the diff, so it ships it along; grounding runs server-side
     against the workspace. Advisory only: failures surface as notices. */
  const [review, setReview] = useState<CodeReviewResult | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const handleRunReview = async () => {
    if (reviewing || !diff) return;
    setReviewing(true);
    try {
      const diffText = files.map((file) => file.diff || '').filter(Boolean).join('\n');
      const result = await codeReviewApi.run({
        sessionId: sessionId || undefined,
        workspace: diff.workspace || undefined,
        diffText,
      });
      setReview(result);
    } catch (err) {
      toast.error(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReviewing(false);
    }
  };

  /** Keep every change: nothing to do on disk — dismiss the review pane. */
  const handleKeepAll = () => {
    clearRightDrawerDiff();
    closeRightDrawerSection('diff');
    toast.success('Changes kept');
  };

  return (
    <div className="h-full space-y-3 drawer-section-text">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">
            {diff ? `${files.length} changed file${files.length === 1 ? '' : 's'}` : 'No diff loaded yet'}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs tabular-nums">
            {added > 0 && <span className="text-success">+{added}</span>}
            {removed > 0 && <span className="text-danger">-{removed}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {files.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setExpandedFiles((prev) =>
                  prev.size === files.length ? new Set() : new Set(files.map((f) => f.path)),
                )
              }
              data-testid="diff-expand-all"
            >
              {expandedFiles.size === files.length ? 'Collapse all' : 'Expand all'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!sessionId || query.isFetching}
            onClick={refreshDiff}
            title="Reload the working-tree diff"
          >
            <RefreshCw className={cn('size-3', query.isFetching && 'animate-spin')} />
            Refresh
          </Button>
          {files.length > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={reviewing}
                onClick={() => void handleRunReview()}
                data-testid="diff-review-button"
                title="Run an advisory code review of this changeset"
              >
                {reviewing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <SearchCheck className="size-3" />
                )}
                Review
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleKeepAll}
                title="Keep all changes and close the review"
              >
                <Check className="size-3" />
                Keep all
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!sessionId || reverting}
                onClick={revertAll}
                className="text-danger hover:text-danger"
                title="Revert all changes to the last save point"
              >
                {reverting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Undo2 className="size-3" />
                )}
                Revert all
              </Button>
            </>
          )}
        </div>
      </div>

      {review && (
        <ReviewFindingsPanel
          result={review}
          onSelectFile={(path) => {
            if (!diff) return;
            setRightDrawerDiff(diff, path);
            // Jump-to-line parity with the anchored findings: locate the
            // first finding row once the selection has re-rendered.
            const first = (review.findings ?? []).find((f) => f.file === path && f.line > 0);
            if (first) {
              window.setTimeout(() => {
                document
                  .getElementById(`${diffAnchorPrefix(path)}-${first.line}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 120);
            }
          }}
          onDismiss={() => setReview(null)}
        />
      )}

      {!diff && query.isLoading && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          Loading diff…
        </div>
      )}

      {!diff && query.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive">
          {(query.error).message}
        </div>
      )}

      {files.length === 0 && diff && (
        <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-center text-muted-foreground">
          Working tree is clean.
        </div>
      )}

      <div className="space-y-3">
        {files.map((file) => {
          const selected = drawer.selectedDiffPath === file.path;
          const open = expandedFiles.has(file.path);
          return (
            <div
              key={file.path}
              className={cn(
                'overflow-hidden rounded-lg border bg-card/40',
                selected ? 'border-primary/50' : 'border-border/60'
              )}
            >
              {/* Hermes-parity file header: the row IS the disclosure, and
                  the stats live on it so a collapsed changeset still reads
                  as a list (previously every file rendered expanded). */}
              <div
                className={cn(
                  'flex items-center justify-between gap-2 border-b px-2.5 py-1.5',
                  selected ? 'border-primary/30 bg-primary/10' : 'border-border/50 bg-muted/20'
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpandedFiles((prev) => toggleIn(prev, file.path))}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={open}
                  data-testid={`diff-file-toggle-${file.path}`}
                >
                  <ChevronRight
                    className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')}
                    aria-hidden
                  />
                  <FileIcon name={file.path} size={13} className="shrink-0" />
                  <span className="truncate font-mono text-xs text-foreground/85" title={file.path}>
                    {file.path}
                  </span>
                </button>
                <div className="flex items-center gap-1.5 shrink-0">
                  {file.status && <Badge variant="secondary" className="text-2xs">{file.status}</Badge>}
                  <span className="font-mono text-xs text-success">+{file.added}</span>
                  <span className="font-mono text-xs text-danger">-{file.removed}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(file.diff ?? '');
                      toast.success('Patch copied');
                    }}
                    className="rounded p-0.5 text-muted-foreground/60 transition hover:bg-accent hover:text-foreground"
                    aria-label={`Copy patch for ${file.path}`}
                    title="Copy patch"
                  >
                    <Copy className="size-3" />
                  </button>
                </div>
              </div>

              {open && (file.diff?.trim() ? (
                <DiffView
                  diff={file.diff}
                  maxLines={240}
                  anchors={
                    review && !review.skipped
                      ? (review.findings ?? [])
                          .filter((f) => f.file === file.path && f.line > 0)
                          .map((f) => ({ line: f.line, tag: f.tag, title: f.title }))
                      : undefined
                  }
                  idPrefix={diffAnchorPrefix(file.path)}
                />
              ) : (
                <div className="p-3 text-center text-muted-foreground/60">No diff content available.</div>
              ))}
            </div>
          );
        })}
      </div>

      {/* U2: commit composer — stage-free commit of the current working tree,
          with an optional AI-generated message (session's own model). */}
      {files.length > 0 && sessionId && (
        <CommitComposer sessionId={sessionId} onCommitted={() => {
          clearRightDrawerDiff();
          refreshDiff();
        }} />
      )}
      {confirmDialog}
    </div>
  );
}

/* ── CommitComposer — message input + generate + commit ──────────────── */

function CommitComposer({ sessionId, onCommitted }: { sessionId: string; onCommitted: () => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  /** Ask the session's model for a conventional-commit message from the diff. */
  const generateMessage = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const data = await api.post<{ output?: string; answer?: string; text?: string }>(
        '/api/workbench/btw',
        {
          sessionId,
          question:
            'Write a git commit message for the current working-tree changes. Reply with ONLY the subject line plus an optional short body — no quotes, no backticks, no commentary.',
        },
      );
      const text = (data.output || data.answer || data.text || '').trim();
      if (text) setMessage(text.slice(0, 500));
      else throw new Error('empty suggestion');
    } catch (err) {
      toast.error(`Could not generate a message: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleCommit = async () => {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      // The drawer presents the whole working-tree diff, so stage and commit
      // both staged and unstaged changes. The API defaults to staged-only for
      // callers that intentionally want a narrower commit.
      await gitApi.commit(sessionId, trimmed, undefined, true);
      toast.success('Committed');
      setMessage('');
      onCommitted();
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-2.5 space-y-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message…"
        rows={2}
        data-testid="git-commit-message"
        className="w-full resize-none rounded-md border border-border/60 bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={!message.trim() || busy}
          onClick={() => void handleCommit()}
          data-testid="git-commit-button"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Commit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={generating || busy}
          onClick={() => void generateMessage()}
          title="Draft a message from the diff using this session's model"
          data-testid="git-generate-message"
        >
          {generating ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          Generate
        </Button>
        <span className="ml-auto text-2xs text-muted-foreground">
          Commits staged + unstaged changes
        </span>
      </div>
    </div>
  );
}
