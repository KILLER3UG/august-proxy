/* ── SubagentDelegateRow — inline transcript row for a delegated worker ── */
/* Reverses the "drawer-only" decision — every launched agent
   gets one first-class row where the user is reading.

   The row is a disclosure: it carries the worker's own status line, and when
   a transcript is available (live SSE container, or the `subagent` block
   restored from the persisted parent message) it expands INLINE into that
   worker's timeline. Opening the right drawer stays available as a secondary
   affordance — the inline block is about reading a result in context, the
   drawer is about the full session of workers. */

import { useEffect, useState } from 'react';
import { Bot, ChevronRight, Loader2, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import type { SubagentBlockState } from '@/types/chat';

export interface SubagentDelegateRowProps {
  jobId?: string;
  agentId: string;
  task: string;
  /** Live container status when present; tool-call status when reloaded. */
  status: 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'done' | 'error';
  startedAt?: number;
  finishedAt?: number;
  workstream?: string;
  /** The worker's own timeline, when one is available. Supplied from the
   *  live `subagentBlocks` map or from the restored `subagent` block; the row
   *  degrades to a status-only stub when it is absent. */
  state?: SubagentBlockState;
  /** Render the inline timeline open on first paint (a running worker). */
  defaultExpanded?: boolean;
  /** Owning session id — threaded into the timeline's tool cards. */
  sessionId?: string | null;
}

/** Normalize a start time that may arrive in epoch seconds (backend seed)
 *  or milliseconds (SSE path) — mixing them showed ~1.7e9 "seconds". */
function toMs(t: number): number {
  return t > 1e12 ? t : t * 1000;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

export function SubagentDelegateRow({
  jobId,
  agentId,
  task,
  status,
  startedAt,
  workstream,
  state,
  defaultExpanded,
  sessionId,
}: SubagentDelegateRowProps) {
  const running = status === 'running' || status === 'pending';
  const [elapsed, setElapsed] = useState(() =>
    startedAt ? Date.now() - toMs(startedAt) : 0,
  );

  useEffect(() => {
    if (!running || !startedAt) return;
    const id = window.setInterval(() => setElapsed(Date.now() - toMs(startedAt)), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);

  // A running worker opens itself so the user watches it work; a settled one
  // starts collapsed so a turn that spawned several workers does not bury its
  // answer under their transcripts. The user can always override, and their
  // choice is NOT reset when the worker finishes mid-read.
  const hasTranscript = !!state && state.blocks.length > 0;
  const [expanded, setExpanded] = useState(
    () => defaultExpanded ?? (running && hasTranscript),
  );

  const role = getAgentRoleLabel(agentId);
  const failed = status === 'failed' || status === 'error';
  const cancelled = status === 'cancelled';
  // `partial` is the worker hitting its round cap or stalling with some text
  // produced. It used to render exactly like a clean success, so a delegated
  // job that returned half an answer looked identical to one that finished —
  // the same honesty defect the turn_end badge already guards at turn level.
  const partial = status === 'partial';

  const openDrawer = () => {
    if (!jobId) return;
    setFocusedSubagent({
      jobId,
      title: task || role,
      workstream: workstream?.trim() || undefined,
      running,
    });
    addRightDrawerSection('subagents');
  };

  const toggle = () => {
    if (!hasTranscript) {
      openDrawer();
      return;
    }
    setExpanded((v) => !v);
  };

  return (
    <div
      className="subagent-delegate-row row-enter w-full min-w-0"
      data-testid="subagent-delegate-row"
      data-subagent-id={jobId}
      data-subagent-status={status}
      data-expanded={expanded && hasTranscript ? 'true' : 'false'}
    >
      <div className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] leading-5 transition-colors hover:bg-white/[0.03]">
        {hasTranscript ? (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={task || undefined}
            data-testid="subagent-delegate-toggle"
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-muted-foreground/50 transition-transform',
                expanded && 'rotate-90',
              )}
              aria-hidden
            />
            <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground/90">
              {running ? (
                <Loader2 className="size-3.5 animate-spin text-primary/80" aria-hidden />
              ) : (
                <Bot className="size-3.5 text-muted-foreground/70" aria-hidden />
              )}
              SubAgent
            </span>
            <span className="shrink-0 text-info/90">{role}</span>
            <span className="shrink-0 text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
              {task || role}
            </span>
            {running && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                {fmtElapsed(elapsed)}
              </span>
            )}
            {failed && (
              <span className="shrink-0 text-[11px] text-destructive/80 underline decoration-dotted underline-offset-2">
                Failed
              </span>
            )}
            {cancelled && (
              <span className="shrink-0 text-[11px] text-muted-foreground/60 underline decoration-dotted underline-offset-2">
                Cancelled
              </span>
            )}
            {partial && (
              <span
                className="shrink-0 text-[11px] text-warning/90 underline decoration-dotted underline-offset-2"
                title="The worker stopped before finishing — what you see is part of its answer, not all of it."
                data-testid="subagent-delegate-partial"
              >
                Partial
              </span>
            )}
          </button>
        ) : (
          /* No transcript (a spawn whose worker never reported, or a legacy
             row): the whole line is the drawer affordance, as before. */
          <button
            type="button"
            onClick={openDrawer}
            disabled={!jobId}
            className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            title={task || undefined}
          >
            <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground/90">
              {running ? (
                <Loader2 className="size-3.5 animate-spin text-primary/80" aria-hidden />
              ) : (
                <Bot className="size-3.5 text-muted-foreground/70" aria-hidden />
              )}
              SubAgent
            </span>
            <span className="shrink-0 text-info/90">{role}</span>
            <span className="shrink-0 text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground/80">
              {task || role}
            </span>
            {running && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                {fmtElapsed(elapsed)}
              </span>
            )}
            {failed && (
              <span className="shrink-0 text-[11px] text-destructive/80 underline decoration-dotted underline-offset-2">
                Failed
              </span>
            )}
            {cancelled && (
              <span className="shrink-0 text-[11px] text-muted-foreground/60 underline decoration-dotted underline-offset-2">
                Cancelled
              </span>
            )}
            {partial && (
              <span
                className="shrink-0 text-[11px] text-warning/90 underline decoration-dotted underline-offset-2"
                title="The worker stopped before finishing — what you see is part of its answer, not all of it."
                data-testid="subagent-delegate-partial"
              >
                Partial
              </span>
            )}
          </button>
        )}
        {jobId && hasTranscript && (
          <button
            type="button"
            onClick={openDrawer}
            className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition hover:bg-white/[0.06] hover:text-foreground"
            aria-label="Open in drawer"
            title="Open in drawer"
            data-testid="subagent-delegate-open-drawer"
          >
            <PanelRightOpen className="size-3" aria-hidden />
          </button>
        )}
      </div>
      {expanded && hasTranscript && state ? (
        <div
          className="mt-1 ml-3 border-l border-border/40 pl-3"
          data-testid="subagent-delegate-body"
          data-slot="subagent-inline-transcript"
        >
          <SubagentTimeline state={state} hideTaskPrompt sessionId={sessionId ?? undefined} />
        </div>
      ) : null}
    </div>
  );
}
