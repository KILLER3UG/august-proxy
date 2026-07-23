/**
 * Tool step: one collapsible Task block per tool call.
 *
 * Open state: opens while the tool is running and stays however the user
 * leaves it once the tool completes — never force-collapsed on completion.
 * The parent-derived `expanded` prop seeds the initial state and re-opens
 * on (re-)entering running; closing is purely user-driven.
 */

import { Children, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, Loader2, Pencil } from 'lucide-react';
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
  // tools (path lives on the label). Don't treat that empty element as expandable.
  const hasExpandableContent = !!(
    hasTaskRows ||
    tool.error ||
    tool.inlineDiff ||
    (tool.searchHits && tool.searchHits.length > 0) ||
    tool.providerSetup ||
    tool.pendingApproval ||
    (!isView && hasChildren)
  );
  // View tools stay header-only while empty (no blank "Running…" panel).
  const canExpand = hasExpandableContent || (running && !isView);
  const showEmptyFallback = !hasTaskRows && !hasChildren;

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
              )}
              title={filename ?? undefined}
            >
              {label}
            </span>
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
