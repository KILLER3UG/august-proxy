/**
 * Beginner-friendly live / final shell output for run_command tools.
 * Strips sandbox metadata + ANSI, applies \r progress-bar updates, auto-scrolls.
 */

import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { extractCommand } from './extractors';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const SANDBOX_TAG_RE = /^\[sandbox:[^\]]*\]\s*/i;
const STDERR_HEADER_RE = /^STDERR:\s*$/im;
const EXIT_CODE_RE = /(?:^|\n)Exit code:\s*(-?\d+)\s*$/i;

/** Apply carriage-return progress updates (pip/npm style) into stable lines. */
export function applyCarriageReturns(text: string): string {
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const part of parts) {
    const segments = part.split('\r');
    out.push(segments[segments.length - 1] ?? '');
  }
  return out.join('\n');
}

/** Clean tool result / live preview for humans. */
export function formatCommandOutputForDisplay(raw: string): {
  body: string;
  exitCode: number | null;
  failed: boolean;
} {
  let text = (raw || '').replace(ANSI_RE, '');
  text = text.replace(SANDBOX_TAG_RE, '');
  // Drop trailing "Exit code: N" — we surface it as a chip.
  let exitCode: number | null = null;
  const exitMatch = text.match(EXIT_CODE_RE);
  if (exitMatch) {
    exitCode = Number(exitMatch[1]);
    text = text.replace(EXIT_CODE_RE, '').trimEnd();
  }
  text = applyCarriageReturns(text);
  // Soften STDERR header
  text = text.replace(STDERR_HEADER_RE, 'Errors:');
  text = text.replace(/^\(no output\)\s*$/i, 'No output.');
  const failed = exitCode !== null && exitCode !== 0;
  return { body: text.trimEnd(), exitCode, failed };
}

function shortenCommand(cmd: string, max = 96): string {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function CommandOutputPane({
  toolName,
  context,
  preview,
  summary,
  status,
}: {
  toolName: string;
  context?: string;
  preview?: string;
  summary?: string;
  status: 'running' | 'done' | 'error' | string;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const command = extractCommand(context) || toolName.replace(/^@/, '');
  const running = status === 'running';
  const source = running
    ? (preview || '')
    : (summary || preview || '');
  const { body, exitCode, failed } = formatCommandOutputForDisplay(source);
  const showBody = body.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !running) return;
    el.scrollTop = el.scrollHeight;
  }, [body, running]);

  let statusLabel = 'Done';
  let statusClass = 'text-emerald-400/90';
  if (running) {
    statusLabel = 'Running';
    statusClass = 'text-sky-300/90';
  } else if (failed || status === 'error') {
    statusLabel = exitCode !== null ? `Failed · exit ${exitCode}` : 'Failed';
    statusClass = 'text-rose-300/90';
  } else if (exitCode === 0) {
    statusLabel = 'Done';
  }

  return (
    <div
      className="mt-1.5 w-full max-w-2xl overflow-hidden rounded-lg border border-white/[0.08] bg-[#0c0f14]"
      data-testid="command-output-pane"
    >
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
        <span className="font-mono text-[11px] text-emerald-400/80 shrink-0">$</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85"
          title={command}
        >
          {shortenCommand(command)}
        </span>
        <span className={cn('flex items-center gap-1 shrink-0 text-[10px] font-medium', statusClass)}>
          {running && <Loader2 className="size-3 animate-spin" />}
          {statusLabel}
        </span>
      </div>
      {showBody ? (
        <pre
          ref={scrollRef}
          className="tool-result-scroll m-0 max-h-56 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11px] leading-5 text-foreground/80 whitespace-pre-wrap break-words"
          onWheel={(e) => {
            if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
          }}
        >
          {body}
          {running && (
            <span className="inline-block w-1.5 h-3 align-middle bg-foreground/35 ml-0.5 animate-pulse" />
          )}
        </pre>
      ) : (
        <div className="px-3 py-2 text-[11px] text-muted-foreground/70 italic">
          {running ? 'Waiting for output…' : 'No output.'}
        </div>
      )}
    </div>
  );
}
