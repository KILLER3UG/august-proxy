import { useEffect, useState } from 'react';
import { AlertCircle, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { type ProgressEntry } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { formatToolContext } from '@/lib/tool-context-format';
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

// Above this length the per-character shimmer animation becomes visually
// noisy and slow. Used to decide between the animated "thinking-text" path
// and the plain monospace fallback.
const LONG_LABEL_THRESHOLD = 40;
function isLongLabel(label: string): boolean {
  return label.length > LONG_LABEL_THRESHOLD;
}

/**
 * ToolCallItem — renders one tool call like the Thinking disclosure.
 *
 * Uses DisclosureRow + char-glow animation (thinking-text) instead of
 * a bordered card. The tool name animates while running, same as the
 * "Thinking" label in ThinkingDisclosure.
 */
export function ToolCallItem({
  tool,
  progress,
  agentIdOverride,
}: {
  tool: ToolEntry;
  /** Optional live "Reading… / Read" sub-list emitted by the workbench. */
  progress?: ReadonlyArray<ProgressEntry>;
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
  const labelTitle = isCommand && commandText && commandText.length > 120
    ? commandText
    : isLongLabel(label) ? label : undefined;
  const displayLabel = (elapsed !== undefined && elapsed >= 100) ? `${label} · ${formatTimer(elapsed)}` : label;

  // Always-visible friendly context line: prefer the humanized summary from
  // formatToolContext; fall back to a single-line truncation of the raw
  // JSON args when no formatter matches.
  const friendlyCtx = tool.context ? formatToolContext(tool.name, tool.context) : null;
  const inlineContextText =
    friendlyCtx?.summary ??
    (tool.context && tool.context.length > 80
      ? `${tool.context.slice(0, 77).trimEnd()}…`
      : tool.context ?? null);

  return (
    <div className="text-xs text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setUserOverride(!open) : undefined}
        open={open && hasBody}
      >
        <span className="flex min-w-0 items-center gap-2">
          {filename ? (
            <FileIcon name={filename} size={14} className="shrink-0" />
          ) : (
            <ToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-xs font-medium leading-5 min-w-0 flex-1',
              isRunning && !isLongLabel(label) && 'text-foreground/85'
            )}
            title={labelTitle}
          >
            {isLongLabel(label) ? (
              // Long labels (typically a multi-flag shell command) bypass the
              // per-character shimmer animation: animating 100+ chars with a
              // 100ms stagger is visually noisy. Render as a plain monospace
              // span with a `title` tooltip for the full text.
              <span className="font-mono text-[11.5px] text-foreground/85 wrap-anywhere break-words">
                {displayLabel}
              </span>
            ) : (
              <span className="thinking-text">
                <span className="thinking-label">
                  {Array.from(displayLabel.replace(/ /g, '\u00A0')).map((ch, i) => (
                    <span
                      key={i}
                      className={cn('thinking-char', i === 0 && 'thinking-cap')}
                      style={{ animationDelay: `${i * 100}ms` }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
                {isRunning && (
                  <span className="thinking-dots">
                    <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                    <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                    <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 shrink-0 ml-auto pl-2">
            {isRunning && liveBackend.label && (
              <span
                className="tool-row-meta text-sky-300/90 max-w-[7.5rem] truncate"
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

      {open && hasBody && (
        <ToolCallItemBody tool={tool} progress={progress} />
      )}
    </div>
  );
}
