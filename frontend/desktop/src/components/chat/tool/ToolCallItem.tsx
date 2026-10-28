import { memo, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SignalIcon } from '@/components/ui/SignalIcon';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { type ProgressEntry } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { classifyTool } from '@/lib/tool-classify';
import { useLiveBackendAction } from '@/hooks/useLiveBackendAction';
import { extractFilename, extractCommand, extractAgentId, extractSubject } from './extractors';
import type { ToolEntry } from './types';
import { ToolCallItemBody } from './ToolCallItemBody';

// Above this length the label is a multi-flag shell command or a long path,
// and monospace reads better than the proportional label font. The label is
// one line either way — it truncates, with the full text on the tooltip.
const LONG_LABEL_THRESHOLD = 40;
function isLongLabel(label: string): boolean {
  return label.length > LONG_LABEL_THRESHOLD;
}

/**
 * ToolCallItem — renders one tool call like the Thinking disclosure.
 *
 * One line: an icon, the label (truncated, with the full text on the
 * tooltip), the running dots, and a status chip in the DisclosureRow's
 * `trailing` slot — OUTSIDE the trigger button, so it is not swallowed into
 * the button's accessible name and a click on it does not toggle the row.
 * The result lives in the expanded body.
 */
export const ToolCallItem = memo(function ToolCallItem({
  tool,
  progress,
  sessionId,
  agentIdOverride,
}: {
  tool: ToolEntry;
  /** Optional live "Reading… / Read" sub-list emitted by the workbench. */
  progress?: ReadonlyArray<ProgressEntry>;
  /** Owning session id — threaded into the F6 escalation card so the
   *  "I'm done" handler can resume the run on the right session. */
  sessionId?: string;
  agentIdOverride?: string;
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? (tool.status === 'error' || tool.status === 'stalled');

  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tool.status !== 'running') return;
    const id = window.setInterval(() => setNow(() => Date.now()), 500);
    return () => window.clearInterval(id);
  }, [tool.status]);

  let startedAtMs: number | undefined = undefined;
  if (tool.startedAt) {
    if (typeof tool.startedAt === 'number') {
      startedAtMs = tool.startedAt;
    } else if (typeof tool.startedAt === 'string') {
      const parsedNum = Number(tool.startedAt);
      if (!isNaN(parsedNum)) {
        startedAtMs = parsedNum;
      } else {
        const parsedDate = new Date(tool.startedAt).getTime();
        if (!isNaN(parsedDate)) {
          startedAtMs = parsedDate;
        }
      }
    } else if ((tool.startedAt as unknown) instanceof Date) {
      startedAtMs = (tool.startedAt as Date).getTime();
    }
  }

  if (tool.status === 'running' && (!startedAtMs || isNaN(startedAtMs))) {
    startedAtMs = mountedAt;
  }

  const hasTimestamps = tool.duration !== undefined || (tool.status === 'running' && startedAtMs !== undefined);
  const elapsed = hasTimestamps
    ? tool.duration ?? (startedAtMs ? now - startedAtMs : undefined)
    : undefined;


  const isView = classifyTool(tool.name) === 'view';
  const hasBody = !!(
    (!isView && tool.context) ||
    (!isView && tool.preview) ||
    (!isView && tool.summary) ||
    tool.error ||
    tool.inlineDiff ||
    tool.searchHits ||
    tool.providerSetup ||
    tool.pendingApproval
  );

  const isRunning = tool.status === 'running';
  // Live backend stage while this tool action is executing on the server.
  const liveBackend = useLiveBackendAction(isRunning);
  // Safety timeout: if a tool has been running for > 120 seconds without a
  // result event, treat it as stalled — show a warning so the user knows
  // something went wrong rather than seeing an infinite spinner.
  const toolStalled = isRunning && startedAtMs !== undefined && (now - startedAtMs) > 120_000;
  const isCommand = tool.name.startsWith('@run_command') || tool.name.startsWith('run_command');
  // Strip the @ prefix that the workbench sometimes prepends so the icon
  // mapper matches the canonical tool name (e.g. "read_file" not "@read_file").
  const toolNameForIcon = tool.name.replace(/^@/, '');
  // For run_command tools, surface the actual command string inline so the
  // user can see what's being executed without expanding the disclosure —
  // especially important when the model runs a batch of commands and the
  // user is scanning the list. Truncate long commands with a tooltip that
  // shows the full text.
  const commandText = isCommand ? extractCommand(tool.context) : null;
  const filename = !isCommand ? extractFilename(tool.context) : null;
  const agentId = agentIdOverride || extractAgentId(tool.context);

  const label = getToolLabel(tool.name, {
    agentId: agentId ?? undefined,
    filename: filename ?? undefined,
    command: commandText ?? undefined,
    subject: !isCommand && !filename ? extractSubject(tool.context) ?? undefined : undefined,
    status: tool.status
  });
  const labelTitle =
    (!isCommand && filename) ? filename
    : (isCommand && commandText && commandText.length > 120) ? commandText
    : isLongLabel(label) ? label
    : undefined;
  // The row's second line. A view/read tool has no expanded body (its
  // payload IS the file, and the label already carries the basename), so the
  // full path is the one thing the row can still add. Every other tool shows
  // its humanised context in the expanded body, where the raw args live too
  // — a wall of `{"filePath":"…"}` under the label was noise, and it
  // duplicated what the body renders.
  const inlineContextText = isView ? filename : null;

  const bodyId = `tool-body-${tool.id ?? tool.name}`;
  const headerId = `tool-head-${tool.id ?? tool.name}`;
  const subtitle = commandText || filename || tool.summary || null;
  const statusWord =
    tool.status === 'error'
      ? 'FAILED'
      : tool.status === 'stalled' || toolStalled
        ? 'STALLED'
        : tool.status === 'done'
          ? 'OK'
          : tool.status === 'running'
            ? tool.pendingApproval
              ? 'AWAIT'
              : 'RUN'
            : null;

  return (
    <div
      className="tool-card row-enter"
      data-open={open && hasBody}
      data-slot="tool-block"
      data-testid="tool-call-card"
    >
      <Button
        variant="bare"
        id={headerId}
        type="button"
        className="tool-head"
        onClick={hasBody ? () => setUserOverride(!open) : undefined}
        aria-expanded={hasBody ? open : undefined}
        aria-controls={hasBody ? bodyId : undefined}
      >
        <span className="tool-icon">
          {filename ? (
            <FileIcon name={filename} size={13} />
          ) : (
            <ToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={13} />
          )}
        </span>
        <span className="tool-copy">
          <strong title={label}>{toolNameForIcon}</strong>
          <span title={labelTitle ?? label}>
            {subtitle ?? label}
            {isRunning && liveBackend.label ? ` · ${liveBackend.active?.stage || 'backend'}` : ''}
          </span>
        </span>
        {statusWord ? (
          <span
            className="tool-status"
            data-state={
              tool.status === 'error' || tool.status === 'stalled' || toolStalled
                ? 'error'
                : tool.status === 'running'
                  ? 'running'
                  : 'done'
            }
          >
            {statusWord}
          </span>
        ) : null}
        {elapsed !== undefined ? (
          <span className="tool-duration">{elapsed < 1000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1000).toFixed(1)}s`}</span>
        ) : null}
        {hasBody ? <SignalIcon name="chev" className="tool-chev" /> : null}
      </Button>

      {hasBody ? (
        <div
          className="tool-body"
          id={bodyId}
          role="region"
          aria-labelledby={headerId}
          hidden={!open}
        >
          <ToolCallItemBody tool={tool} progress={progress} sessionId={sessionId} />
        </div>
      ) : null}

      {inlineContextText ? (
        <div className="tool-row-meta mt-0.5 text-muted-foreground/85 truncate" title={tool.context ?? inlineContextText}>
          {inlineContextText}
        </div>
      ) : null}
    </div>
  );
});
