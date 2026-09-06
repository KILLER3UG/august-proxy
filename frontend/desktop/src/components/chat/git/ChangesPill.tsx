/* ── ChangesPill — Z.ai-style git cluster for the chat corner ─────────── */
/* A "Changes +N −M" pill floats top-right of the transcript when the       */
/* session's workspace has uncommitted changes. Clicking opens the Git      */
/* tools popover: the per-file change list, the branch menu (shared with    */
/* the titlebar chip), "Commit or push", the session plan's Progress steps, */
/* and the live sub-agent roster. The commit modal covers commit /          */
/* commit-and-push (Ctrl+Enter) / push.                                     */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { gitApi, type GitStatus } from '@/api/git';
import { cn } from '@/lib/utils';
import { BranchMenuBody } from '@/components/workspace/WorkspaceBranchChip';
import { useSessionStreamStore } from '@/sections/chat/stream/session-stream-store';

type RosterEntry = {
  jobId: string;
  agentId: string;
  task: string;
  status: string;
};

export function ChangesPill({
  sessionId,
  roster,
  className,
}: {
  sessionId: string | null | undefined;
  /** Live sub-agent roster (prop from the message pane) for the Agents section. */
  roster?: ReadonlyArray<RosterEntry>;
  className?: string;
}) {
  const sid = (sessionId || '').trim() || undefined;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'main' | 'branches'>('main');
  const [showFiles, setShowFiles] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const status = useQuery({
    queryKey: ['git', 'status', sid ?? null, null],
    queryFn: () => gitApi.status(sid, undefined),
    enabled: Boolean(sid),
    refetchInterval: 20_000,
    staleTime: 5_000,
    retry: false,
  });
  const branch = useQuery({
    queryKey: ['git', 'branch', sid ?? null, null],
    queryFn: () => gitApi.branch(sid, undefined),
    enabled: Boolean(sid),
    refetchInterval: 30_000,
    retry: false,
  });
  const workbenchSession = useSessionStreamStore((s) =>
    sid ? s.bySession[sid]?.workbenchSession ?? null : null,
  );

  const notGitRepo = Boolean(
    status.data?.error && /not a git repository/i.test(status.data.error),
  );
  const files = status.data?.files ?? [];
  const added = status.data?.added ?? 0;
  const removed = status.data?.removed ?? 0;
  const current = branch.data?.current ?? null;
  const planSteps = workbenchSession?.plan?.steps ?? [];
  const agents = (roster ?? []).filter((r) => ['running', 'pending'].includes(r.status));

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!sid || notGitRepo) return null;
  if (files.length === 0 && !open) return null;

  return (
    <div ref={rootRef} className={cn('absolute right-4 top-2 z-30', className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setView('main');
        }}
        data-testid="changes-pill"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border border-border bg-card/95 px-2.5 py-1.5 text-xs shadow-sm transition',
          'hover:bg-muted/60',
          open && 'bg-muted/60',
        )}
      >
        <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground/90">Changes</span>
        <span className="font-mono tabular-nums text-emerald-500">+{added}</span>
        <span className="font-mono tabular-nums text-red-400">-{removed}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 max-h-[min(72vh,520px)] w-80 overflow-y-auto rounded-xl border border-border bg-card shadow-2xl animate-in fade-in slide-in-from-top-1 duration-100 chat-scroll"
          data-testid="git-tools-popover"
        >
          {view === 'branches' ? (
            <div className="p-1.5">
              <BranchMenuBody
                sessionId={sid}
                repoPath={undefined}
                current={current}
                onDone={() => setOpen(false)}
              />
            </div>
          ) : (
            <>
              <div className="px-3 pb-1 pt-2.5 text-[13px] font-semibold text-foreground">
                Git tools
              </div>
              {/* Changes — totals, expandable per-file list. */}
              <button
                type="button"
                data-testid="git-tools-changes"
                onClick={() => setShowFiles((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/90 transition hover:bg-muted/50"
              >
                <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
                Changes
                <span className="ml-auto font-mono tabular-nums text-[11px]">
                  <span className="text-emerald-500">+{added}</span>{' '}
                  <span className="text-red-400">-{removed}</span>
                </span>
              </button>
              {showFiles && (
                <div className="pb-1" data-testid="git-tools-files">
                  {files.map((f) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-2 px-3 py-1 pl-6 text-[11px]"
                      title={`${f.status} · ${f.path}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground/75">
                        {f.path}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-emerald-500">+{f.added}</span>
                      <span className="shrink-0 font-mono tabular-nums text-red-400">-{f.removed}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Branch — drills into the shared branch menu. */}
              <button
                type="button"
                data-testid="git-tools-branch"
                onClick={() => setView('branches')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/90 transition hover:bg-muted/50"
              >
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">{current || '—'}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
              {/* Commit or push */}
              <button
                type="button"
                data-testid="git-tools-commit"
                onClick={() => {
                  setOpen(false);
                  setCommitOpen(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/90 transition hover:bg-muted/50"
              >
                <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                Commit or push
                <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
              </button>

              {planSteps.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-border/40" />
                  <div
                    className="flex items-center justify-between px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground"
                    data-testid="git-tools-progress"
                  >
                    <span>Progress</span>
                    <span className="font-mono tabular-nums">{planSteps.length} steps</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto pb-1 chat-scroll">
                    {planSteps.map((s, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-1 text-[12px] text-foreground/80">
                        <Circle className="mt-1 size-2 shrink-0 text-muted-foreground/50" />
                        <span className="min-w-0 flex-1">{s}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {agents.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-border/40" />
                  <div className="px-3 pb-1 pt-1.5 text-[11px] text-muted-foreground">Agents</div>
                  <div className="max-h-36 overflow-y-auto pb-1.5 chat-scroll">
                    {agents.map((a) => (
                      <div key={a.jobId} className="flex items-center gap-2 px-3 py-1 text-[12px]">
                        {a.status === 'running' ? (
                          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
                        ) : (
                          <Circle className="size-2 shrink-0 fill-muted-foreground/40 text-muted-foreground/40" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-foreground/80">
                          {a.task || a.agentId}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{a.status}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {commitOpen && (
        <CommitModal sessionId={sid} status={status.data ?? null} branch={current} onClose={() => setCommitOpen(false)} />
      )}
    </div>
  );
}

/** Centered commit modal: message (+ AI generate), include-unstaged toggle,
 *  and Commit / Commit and push (Ctrl+Enter) / Push actions. */
function CommitModal({
  sessionId,
  status,
  branch,
  onClose,
}: {
  sessionId: string | undefined;
  status: GitStatus | null;
  branch: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [busy, setBusy] = useState<'commit' | 'commitPush' | 'push' | 'generate' | null>(null);

  const files = status?.files ?? [];
  const added = status?.added ?? 0;
  const removed = status?.removed ?? 0;

  const generateMessage = async (): Promise<string> => {
    setBusy('generate');
    try {
      const res = await fetch('/api/workbench/btw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          question:
            'Write a git commit message for the current working-tree changes. Reply with ONLY the subject line plus an optional short body — no quotes, no backticks, no commentary.',
        }),
      });
      if (!res.ok) throw new Error(`generate failed: ${res.status}`);
      const data = (await res.json()) as { output?: string; answer?: string; text?: string };
      const text = (data.output || data.answer || data.text || '').trim();
      if (!text) throw new Error('empty suggestion');
      return text.slice(0, 500);
    } catch (err) {
      toast.error(`Could not generate a message: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    } finally {
      setBusy(null);
    }
  };

  const doCommit = async (andPush: boolean) => {
    if (busy) return;
    setBusy(andPush ? 'commitPush' : 'commit');
    try {
      let msg = message.trim();
      if (!msg) {
        msg = await generateMessage();
        if (!msg) return;
        setMessage(msg);
      }
      await gitApi.commit(sessionId!, msg, undefined, includeUnstaged);
      await qc.invalidateQueries({ queryKey: ['git'] });
      if (andPush) {
        try {
          await gitApi.push(sessionId);
          toast.success('Committed and pushed');
        } catch (err) {
          toast.error(
            `Committed, but push failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        toast.success('Committed');
      }
      onClose();
    } catch (err) {
      toast.error(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const doPush = async () => {
    if (busy) return;
    setBusy('push');
    try {
      await gitApi.push(sessionId);
      toast.success('Pushed');
      onClose();
    } catch (err) {
      toast.error(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // Escape closes; Ctrl+Enter runs "Commit and push" (the reference binding).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        void doCommit(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        data-testid="commit-modal-backdrop"
      />
      <div
        className="relative w-[560px] max-w-[94vw] rounded-2xl border border-border bg-card shadow-2xl p-4 animate-in fade-in zoom-in-95 duration-100"
        data-testid="commit-modal"
        role="dialog"
        aria-label="Commit or push"
      >
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-foreground/90">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[220px] truncate font-mono">{branch || '—'}</span>
          </span>
          <span className="ml-auto font-mono text-xs tabular-nums">
            <span className="text-emerald-500">+{added}</span>{' '}
            <span className="text-red-400">-{removed}</span>
          </span>
        </div>

        <div className="relative mt-2">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (leave empty to generate)"
            rows={4}
            data-testid="commit-message-input"
            className="w-full resize-none rounded-lg border border-border/60 bg-transparent px-2.5 py-2 pr-9 text-sm outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
          />
          <button
            type="button"
            title="Generate a commit message from the diff"
            data-testid="generate-commit-message"
            disabled={busy !== null}
            onClick={() => void generateMessage().then((msg) => msg && setMessage(msg))}
            className="absolute right-2 top-2 cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            {busy === 'generate' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
          </button>
        </div>

        <label className="mt-3 flex w-full cursor-pointer items-center gap-2 py-1 text-[13px] text-foreground/90">
          <input
            type="checkbox"
            checked={includeUnstaged}
            onChange={(e) => setIncludeUnstaged(e.target.checked)}
            data-testid="include-unstaged"
            className="size-3.5 accent-[var(--dt-primary)]"
          />
          Include unstaged changes
          <span className="ml-auto text-[11px] text-muted-foreground">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
        </label>

        <div className="mt-2 border-t border-border/40 pt-1.5">
          <button
            type="button"
            data-testid="commit-action"
            disabled={busy !== null}
            onClick={() => void doCommit(false)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-[13px] text-foreground transition hover:bg-muted/60 disabled:opacity-50"
          >
            <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
            Commit
          </button>
          <button
            type="button"
            data-testid="commit-push-action"
            disabled={busy !== null}
            onClick={() => void doCommit(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-[13px] text-foreground transition hover:bg-muted/60 disabled:opacity-50"
          >
            <ArrowUp className="size-4 shrink-0 text-muted-foreground" />
            Commit and push
            <span className="ml-auto rounded border border-border/60 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              Ctrl+↵
            </span>
          </button>
          <button
            type="button"
            data-testid="push-action"
            disabled={busy !== null}
            onClick={() => void doPush()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-[13px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            <ArrowUp className="size-4 shrink-0" />
            Push
            {busy !== null && <Loader2 className="ml-auto size-3.5 animate-spin" />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
