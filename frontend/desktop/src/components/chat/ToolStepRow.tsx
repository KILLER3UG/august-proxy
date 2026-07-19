/**
 * Claude-style tool step: collapsed one-liner; expand for inset Response.
 * Collapse state is owned by the parent (id-keyed) so it survives re-renders.
 */

import { useId, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolIcon } from '@/components/ui/ToolIcon';
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
  const detail =
    tool.summary?.trim() ||
    (tool.context && tool.context.length > 80
      ? `${tool.context.slice(0, 77).trimEnd()}…`
      : tool.context?.trim()) ||
    '';

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
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="process-step-gutter" aria-hidden>
          {running ? (
            <Loader2 className="process-step-icon animate-spin" />
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
        >
          {label}
        </span>
        <ChevronDown
          className={cn(
            'process-tool-chevron',
            expanded && 'process-tool-chevron--open',
          )}
          aria-hidden
        />
      </button>

      {expanded && (
        <div
          id={panelId}
          className="process-tool-panel"
          aria-live={running ? 'polite' : undefined}
        >
          <div className="process-tool-response-label">Response</div>
          {detail && !children ? (
            <div className="process-tool-response">{detail}</div>
          ) : null}
          {children ? (
            <div className="process-tool-response">{children}</div>
          ) : null}
          {!detail && !children ? (
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
