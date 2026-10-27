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
import { ChevronRight, Loader2, PanelRightOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import { setFocusedSubagent } from '@/components/chat/focused-subagent';
import { addRightDrawerSection } from '@/components/shell/RightDrawerState';
import { SubagentTimeline } from '@/components/chat/SubagentTimeline';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
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

  const statusWord = failed
    ? 'failed'
    : cancelled
      ? 'cancelled'
      : partial
        ? 'partial'
        : running
          ? 'running'
          : 'queued';

  // One header, used by both branches: with a transcript the line toggles the
  // inline timeline, without one it opens the drawer. Same anatomy either way,
  // which is the mockup's `.subagent-top` — icon, name, task, status.
  const head = (
    <>
      <span className="subagent-icon">
        {running ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <SignalIcon name="branch" />
        )}
      </span>
      <span className="subagent-name">{role}</span>
      <span className="subagent-task" title={task || undefined}>
        {task || role}
      </span>
      <span className="subagent-status" data-state={statusWord}>
        {statusWord}
      </span>
    </>
  );

  return (
    <div
      className="subagent-delegate-row subagent-row row-enter"
      data-testid="subagent-delegate-row"
      data-subagent-id={jobId}
      data-subagent-status={status}
      data-expanded={expanded && hasTranscript ? 'true' : 'false'}
    >
      <div className="subagent-top">
        {hasTranscript ? (
          <Button
            variant="bare"
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className="subagent-toggle"
            title={task || undefined}
            data-testid="subagent-delegate-toggle"
          >
            <ChevronRight
              className={cn('subagent-chev', expanded && 'rotate-90')}
              aria-hidden
            />
            {head}
            {running ? <span className="subagent-elapsed">{fmtElapsed(elapsed)}</span> : null}
          </Button>
        ) : (
          /* No transcript (a spawn whose worker never reported, or a legacy
             row): the whole line is the drawer affordance, as before. */
          <Button
            variant="bare"
            type="button"
            onClick={openDrawer}
            disabled={!jobId}
            className="subagent-toggle"
            title={task || undefined}
          >
            {head}
            {running ? <span className="subagent-elapsed">{fmtElapsed(elapsed)}</span> : null}
          </Button>
        )}
        {jobId && hasTranscript && (
          <Button
            variant="bare"
            type="button"
            onClick={openDrawer}
            className="subagent-open"
            aria-label="Open in drawer"
            title="Open in drawer"
            data-testid="subagent-delegate-open-drawer"
          >
            <PanelRightOpen className="size-3" aria-hidden />
          </Button>
        )}
      </div>
      {running ? (
        <div className="subagent-progress" aria-hidden>
          <span data-indeterminate="true" />
        </div>
      ) : null}
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
