import { memo, useEffect, useState } from 'react';
import { AlertCircle, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { type ProgressEntry } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { classifyTool } from '@/lib/tool-classify';
import { useLiveBackendAction } from '@/hooks/useLiveBackendAction';
import { extractFilename, extractCommand, extractAgentId } from './extractors';
import type { ToolEntry } from './types';
import { ToolCallItemBody } from './ToolCallItemBody';

/**
 * Format milliseconds to MM:SS format.
 */
function formatTimer(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${pad(minutes)}:${pad(seconds)}`;
}

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
  const open = userOverride ?? tool.status === 'error';

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
  // Whether the status chip has anything to say. It renders in the
  // DisclosureRow's `trailing` slot, which sits OUTSIDE the trigger button —
  // as a child of the button it was part of the button's accessible name and
  // a click on it toggled the disclosure.
  const showStatus =
    (isRunning && !!liveBackend.label) ||
    toolStalled ||
    tool.status === 'done' ||
    tool.status === 'error' ||
    (tool.status === 'running' && !!tool.pendingApproval);
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
    status: tool.status
  });
  const labelTitle =
    (!isCommand && filename) ? filename
    : (isCommand && commandText && commandText.length > 120) ? commandText
    : isLongLabel(label) ? label
    : undefined;
  const displayLabel = (elapsed !== undefined && elapsed >= 100) ? `${label} · ${formatTimer(elapsed)}` : label;

  // The row's second line. A view/read tool has no expanded body (its
  // payload IS the file, and the label already carries the basename), so the
  // full path is the one thing the row can still add. Every other tool shows
  // its humanised context in the expanded body, where the raw args live too
  // — a wall of `{"filePath":"…"}` under the label was noise, and it
  // duplicated what the body renders.
  const inlineContextText = isView ? filename : null;

  return (
    <div
      className="row-enter text-xs text-muted-foreground w-full py-0.5"
      data-slot="tool-block"
    >
      <DisclosureRow
        onToggle={hasBody ? () => setUserOverride(!open) : undefined}
        open={open && hasBody}
        trailing={
          showStatus ? (
            <span className="flex items-center gap-1.5 shrink-0">
              {isRunning && liveBackend.label && (
                <span
                  className="tool-row-meta text-info max-w-[7.5rem] truncate"
                  data-testid="tool-live-backend"
                  title={liveBackend.label}
                >
                  {liveBackend.active?.stage || 'backend'}
                </span>
              )}
              {toolStalled ? (
                <span className="inline-flex items-center gap-1">
                  <AlertCircle className="size-3 text-warning" />
                  <span className="tool-row-meta text-warning">stalled</span>
                </span>
              ) : tool.status === 'done' ? (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block size-1.5 rounded-full bg-success" />
                  <span className="tool-row-meta text-success">done</span>
                </span>
              ) : tool.status === 'error' ? (
                <span className="inline-flex items-center gap-1">
                  <AlertCircle className="size-3 text-danger" />
                  <span className="tool-row-meta text-danger">failed</span>
                </span>
              ) : tool.status === 'running' && tool.pendingApproval ? (
                <span className="inline-flex items-center gap-1">
                  <CircleDot className="size-3 text-warning animate-pulse" />
                  <span className="tool-row-meta text-warning">awaiting</span>
                </span>
              ) : null}
            </span>
          ) : undefined
        }
        /* The body goes through the disclosure instead of sitting beside it as
           a sibling the trigger knows nothing about: that is what gives the
           pill an `aria-controls` and the body a real hidden state, in BOTH
           states — the closed row is the one a screen reader navigates.

           The body is mounted whether the row is open or closed (that is
           what `forceMount` means), so a settled read — which has no body at
           all — passes `undefined` and gets no region rather than an empty
           one. */
        content={
          hasBody ? (
            <ToolCallItemBody tool={tool} progress={progress} sessionId={sessionId} />
          ) : undefined
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {filename ? (
            <FileIcon name={filename} size={14} className="shrink-0" />
          ) : (
            <ToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          {/* One line, one span. The label used to be split into a <span>
            per character with a staggered animationDelay — but
            `.thinking-char` declares no `animation`, and motion.css holds
            every @keyframes in the app, so the shimmer never ran. The only
            surviving effect was one DOM node per character for every tool
            row in every transcript, and a permanent 60% opacity on every
            label, running or not. The full text is on the tooltip and in
            the expanded body. */}
          <span
            className={cn(
              'min-w-0 truncate text-xs font-medium leading-5',
              isLongLabel(label) && 'font-mono text-[0.71875rem]',
              isRunning && 'text-foreground/85',
            )}
            title={labelTitle}
          >
            {displayLabel}
          </span>
          {isRunning && (
            <span className="thinking-dots" aria-hidden>
              <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
              <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
              <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
            </span>
          )}
        </span>
      </DisclosureRow>

      {inlineContextText && (
        <div
          className="tool-row-meta mt-0.5 text-muted-foreground/85 truncate"
          title={tool.context ?? inlineContextText}
        >
          {inlineContextText}
        </div>
      )}
    </div>
  );
});
