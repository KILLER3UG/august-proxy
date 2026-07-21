/**
 * Tool step: collapsed one-liner; expand for inset Response.
 * Collapse state is owned by the parent (id-keyed) so it survives re-renders.
 */

import { Children, useId, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { extractFilename } from '@/components/chat/tool/extractors';
import { classifyTool } from '@/lib/tool-classify';
import { formatToolContext } from '@/lib/tool-context-format';
import type { ToolEntry } from '@/components/chat/ToolCallItem';

export function ToolStepRow({
  tool,
  label,
  expanded,
  onToggle,
  isCommand = false,
  children,
  afterRow,
}: {
  tool: ToolEntry;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  isCommand?: boolean;
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
  const isView = classifyTool(tool.name) === 'view';
  // View tools: no truncated file-body detail — path lives in the row label.
  const friendlyCtx = tool.context ? formatToolContext(tool.name, tool.context) : null;
  const detail = isView
    ? ''
    : (
        tool.summary?.trim() ||
        friendlyCtx?.summary?.trim() ||
        (tool.context && tool.context.length > 80
          ? `${tool.context.slice(0, 77).trimEnd()}…`
          : tool.context?.trim()) ||
        ''
      );
  const childNodes = Children.toArray(children);
  const hasChildren = childNodes.length > 0;
  // ToolCallItemBody is often passed as children but returns null for view/read
  // tools (path lives on the label). Don't treat that empty element as expandable.
  const hasExpandableContent = !!(
    detail ||
    tool.error ||
    tool.inlineDiff ||
    (tool.searchHits && tool.searchHits.length > 0) ||
    tool.providerSetup ||
    tool.pendingApproval ||
    (!isView && hasChildren)
  );
  // View tools stay header-only even while running (no empty "Running…" panel).
  const canExpand = hasExpandableContent || (running && !isView);

  return (
    <div
      className={cn(
        'process-step process-step--tool',
        running && 'process-step--running',
        errored && 'process-step--error',
      )}
      data-slot="tool-step-row"
      data-expanded={expanded ? 'true' : 'false'}
      data-status={tool.status}
    >
      <button
        type="button"
        className="process-tool-toggle"
        onClick={canExpand ? onToggle : undefined}
        aria-expanded={expanded}
        aria-controls={canExpand ? panelId : undefined}
        disabled={!canExpand}
      >
        <span className="process-step-gutter" aria-hidden>
          {running ? (
            <Loader2 className="process-step-icon animate-spin" />
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
            className={cn(
              'process-tool-chevron',
              expanded && 'process-tool-chevron--open',
            )}
            aria-hidden
          />
        )}
      </button>

      {expanded && canExpand && (
        <div
          id={panelId}
          className="process-tool-panel"
          aria-live={running ? 'polite' : undefined}
        >
          <div className="process-tool-response-label">Response</div>
          {detail && !hasChildren ? (
            <div className="process-tool-response">{detail}</div>
          ) : null}
          {hasChildren ? (
            <div className="process-tool-response">{childNodes}</div>
          ) : null}
          {!detail && !hasChildren ? (
            <div className="process-tool-response process-tool-response--empty">
              {running ? 'Running…' : 'No details'}
            </div>
          ) : null}
        </div>
      )}
      {afterRow ? <div className="process-tool-after">{afterRow}</div> : null}
    </div>
  );
}
