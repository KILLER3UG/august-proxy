/**
 * Tool step: one collapsible Task block per tool call.
 *
 * Open state: opens while the tool is running and stays however the user
 * leaves it once the tool completes — never force-collapsed on completion.
 * The parent-derived `expanded` prop seeds the initial state and re-opens
 * on (re-)entering running; closing is purely user-driven.
 */

import { Children, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from '@/components/ui/task';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { extractDiffData, extractFilename } from '@/components/chat/tool/extractors';
import { classifyTool } from '@/lib/tool-classify';
import { commandErrorOneLiner } from '@/lib/command-error-line';
import { formatToolContext } from '@/lib/tool-context-format';
import { pathBasename } from '@/lib/tool-labels';
import { diffStats } from '@/components/chat/DiffView';
import { visibleProgress, type ProgressEntry } from '@/lib/tool-progress';
import type { ToolEntry } from '@/components/chat/ToolCallItem';

/**
 * TaskItem rows summarising the sub-steps of one tool call: per-file
 * progress, file edits (pencil · description · filename pill · ±stat),
 * or a one-line context summary for everything else.
 */
function TaskItemRows({
  tool,
  isCommand,
  progress,
}: {
  tool: ToolEntry;
  isCommand: boolean;
  progress?: ReadonlyArray<ProgressEntry>;
}) {
  const bucket = classifyTool(tool.name);
  const rows: ReactNode[] = [];

  // Per-file progress (read/view sub-steps) — one row per file, basename only.
  const visible = progress ? visibleProgress(progress) : [];
  const overflow = Math.max(0, (progress?.length ?? 0) - visible.length);
  for (const entry of visible) {
    rows.push(
      <TaskItem
        key={`progress-${entry.path}`}
        className="flex min-w-0 items-center gap-2"
        title={entry.path}
      >
        <span className="inline-flex w-3.5 shrink-0 justify-center">
          {entry.status === 'reading' ? (
            <Loader2 className="size-3.5 animate-spin text-info" />
          ) : (
            <Check className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="shrink-0">{entry.status === 'reading' ? 'Reading' : 'Read'}</span>
        <TaskItemFile className="min-w-0">{pathBasename(entry.path)}</TaskItemFile>
      </TaskItem>,
    );
  }
  if (overflow > 0) {
    rows.push(
      <TaskItem key="progress-overflow" className="text-xs italic opacity-70">
        + {overflow} more
      </TaskItem>,
    );
  }

  if (bucket === 'edit') {
    // File edit — pencil, short change description, filename pill, diff stat.
    const filename = extractFilename(tool.context);
    const ctx = tool.context ? formatToolContext(tool.name, tool.context) : null;
    const stats = diffStats(extractDiffData(tool));
    rows.push(
      <TaskItem key="edit" className="flex min-w-0 items-center gap-2">
        <Pencil className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {ctx?.summary?.trim() || 'Edited'}
        </span>
        {filename ? (
          <TaskItemFile className="shrink-0" title={filename}>
            {pathBasename(filename)}
          </TaskItemFile>
        ) : null}
        {stats ? (
          <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-success">+{stats.added}</span>{' '}
            <span className="text-danger">-{stats.removed}</span>
          </span>
        ) : null}
      </TaskItem>,
    );
    // Close the edit run with a bare checkmark + Done row.
    if (tool.status === 'done') {
      rows.push(
        <TaskItem key="edit-done" className="flex items-center gap-2">
          <Check className="size-3.5 text-success" />
          Done
        </TaskItem>,
      );
    }
  } else if (!isCommand && visible.length === 0) {
    // Everything else (non-command, non-edit, no progress): one-line hint.
    const ctx = tool.context ? formatToolContext(tool.name, tool.context) : null;
    const summary = ctx?.summary?.trim();
    if (summary) {
      rows.push(
        <TaskItem key="context" className="truncate" title={summary}>
          {summary}
        </TaskItem>,
      );
    }
  }

  return <>{rows}</>;
}

export function ToolStepRow({
  tool,
  label,
  expanded,
  onToggle,
  isCommand = false,
  verbose = false,
  progress,
  children,
  afterRow,
}: {
  tool: ToolEntry;
  label: string;
  /** Parent-derived open hint (id-keyed). Seeds initial state and re-opens
   *  while running; completion never force-collapses the block. */
  expanded: boolean;
  onToggle: (next: boolean) => void;
  isCommand?: boolean;
  /** /verbose (plan §4.2): minimal locking is lifted — settled read and
   *  successful command rows become expandable into their raw output. */
  verbose?: boolean;
  /** Live per-file progress entries for this tool call. */
  progress?: ReadonlyArray<ProgressEntry>;
  /** Expanded response body */
  children?: ReactNode;
  afterRow?: ReactNode;
}) {
  const reactId = useId();
  const toolId = tool.id || reactId;
  const panelId = `tool-step-panel-${toolId}`;
  const running = tool.status === 'running';
  const errored = tool.status === 'error';
  const filename = !isCommand ? extractFilename(tool.context) : null;
  const bucket = classifyTool(tool.name);
  const isView = bucket === 'view';
  const isEdit = bucket === 'edit';

  const [open, setOpen] = useState(expanded);
  // Re-open when the tool (re-)enters running — never force-close.
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);

  const childNodes = Children.toArray(children);
  const hasChildren = childNodes.length > 0;
  const hasProgress = progress ? visibleProgress(progress).length > 0 : false;
  const friendlyCtx = tool.context ? formatToolContext(tool.name, tool.context) : null;
  const hasTaskRows =
    hasProgress ||
    isEdit ||
    (!isCommand && !isView && !!friendlyCtx?.summary?.trim());
  // ToolCallItemBody is often passed as children but returns null for view/read
  // tools (path lives on the label). Don't treat that empty element as expandable —
  // unless /verbose is on, in which case the body renders raw output for reads too.
  const hasExpandableContent = !!(
    hasTaskRows ||
    tool.error ||
    tool.inlineDiff ||
    (tool.searchHits && tool.searchHits.length > 0) ||
    tool.providerSetup ||
    tool.integrationSetup ||
    tool.pendingApproval ||
    (hasChildren && (!isView || verbose))
  );
  // Minimal-output policy (plan §4.1): settled read rows and successful
  // command rows are header-only — no chevron, nothing to expand into.
  // Failures always stay inspectable (full output behind the click).
  // /verbose lifts the lock so raw output is reachable inline (plan §4.2).
  const minimalLocked =
    !verbose && !running && ((isView && !errored) || (isCommand && !errored));
  // View tools stay header-only while empty (no blank "Running…" panel).
  const canExpand =
    !minimalLocked && (hasExpandableContent || (running && !isView));
  const showEmptyFallback = !hasTaskRows && !hasChildren;
  // Failed commands surface exactly one red line inline — the structured
  // digest when the output carries one, else the first error line.
  const commandErrorLine =
    isCommand && errored
      ? commandErrorOneLiner(tool.error || tool.summary)
      : null;
  // Reads show a duration only when slow enough to be worth noting (>1s).
  const showReadDuration =
    isView && !running && typeof tool.duration === 'number' && tool.duration > 1000;

  return (
    <div
      className={cn(
        'process-step process-step--tool',
        running && 'process-step--running',
        errored && 'process-step--error',
      )}
      data-slot="tool-step-row"
      data-expanded={open && canExpand ? 'true' : 'false'}
      data-status={tool.status}
    >
      <Task
        open={canExpand ? open : false}
        onOpenChange={(next) => {
          setOpen(next);
          onToggle(next);
        }}
      >
        <TaskTrigger title={label} aria-controls={canExpand ? panelId : undefined}>
          <button
            type="button"
            className="process-tool-toggle text-muted-foreground hover:text-foreground"
            disabled={!canExpand}
          >
            <span className="process-step-gutter" aria-hidden>
              {running ? (
                <Loader2 className="process-step-icon animate-spin" />
              ) : errored ? (
                <AlertCircle className="process-step-icon text-danger" />
              ) : filename ? (
                <FileIcon name={filename} size={12} className="process-step-icon-wrap" />
              ) : (
                <ToolIcon
                  name={tool.name}
                  kind={isCommand ? 'command' : 'tool'}
                  size={12}
                  className="process-step-icon-wrap"
                />
              )}
            </span>
            <span
              className={cn(
                'process-tool-label',
                running && 'shimmer process-tool-label--live',
                // Plan 15.1: command rows carry the command in monospace.
                isCommand && 'font-mono text-[11.5px]',
              )}
              title={filename ?? undefined}
            >
              {label}
            </span>
            {isCommand && !running && (
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px',
                  errored
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                )}
                data-testid="tool-status-pill"
                aria-label={errored ? 'Command failed' : 'Command succeeded'}
              >
                {errored ? (
                  <X className="size-2.5" aria-hidden />
                ) : (
                  <Check className="size-2.5" aria-hidden />
                )}
              </span>
            )}
            {showReadDuration && (
              <span
                className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60"
                data-testid="tool-read-duration"
              >
                {(tool.duration! / 1000).toFixed(1)}s
              </span>
            )}
            {commandErrorLine && (
              <span
                className="min-w-0 truncate font-mono text-[10.5px] text-rose-400"
                title={commandErrorLine}
                data-testid="tool-error-line"
              >
                {commandErrorLine}
              </span>
            )}
            {canExpand && (
              <ChevronDown
                className="process-tool-chevron group-data-[state=open]:rotate-180"
                aria-hidden
              />
            )}
          </button>
        </TaskTrigger>

        {canExpand && (
          <TaskContent
            id={panelId}
            className="mb-1 ml-[26px]"
            aria-live={running ? 'polite' : undefined}
          >
            <TaskItemRows tool={tool} isCommand={isCommand} progress={progress} />
            {hasChildren ? childNodes : null}
            {showEmptyFallback ? (
              <TaskItem className="italic opacity-75">
                {running ? 'Running…' : 'No details'}
              </TaskItem>
            ) : null}
          </TaskContent>
        )}
      </Task>
      {afterRow ? <div className="process-tool-after">{afterRow}</div> : null}
    </div>
  );
}
