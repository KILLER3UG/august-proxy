/**
 * Minimal-output command pane (plan §4.1/§4.2):
 *   success → command line + green pill, nothing else;
 *   failure → command line + red pill + ONE red error line (structured
 *             digest when the output carries one), full stdout/stderr
 *             behind the click;
 *   running → command line + running pill, no raw stream into the
 *             transcript (full output lives in the drawer/trajectory).
 *
 * Still exports the ANSI/sandbox/exit-code cleaners so the drawer and the
 * unit tests keep using one code path.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, TerminalSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { commandErrorOneLiner } from '@/lib/command-error-line';
import { extractCommand } from './extractors';

// Strips ANSI escape sequences (CSI + OSC) from terminal output — the
// control characters are the point, so the lint is disabled deliberately.
// eslint-disable-next-line no-control-regex
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
  status: string;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  // Full output is opt-in on failure — start collapsed.
  const [showOutput, setShowOutput] = useState(false);
  const command = extractCommand(context) || toolName.replace(/^@/, '');
  const running = status === 'running';
  const source = running
    ? (preview || '')
    : (summary || preview || '');
  const { body, exitCode, failed } = formatCommandOutputForDisplay(source);
  const isError = !running && (failed || status === 'error');
  const errorLine = isError ? commandErrorOneLiner(body) : null;
  const hasOutput = body.length > 0;
  const showFull = isError && hasOutput && showOutput;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !showFull) return;
    el.scrollTop = 0;
  }, [showFull, body]);

  let statusLabel = 'Done';
  let statusClass = 'bg-emerald-500/10 text-emerald-400';
  if (running) {
    statusLabel = 'Running';
    statusClass = 'bg-sky-500/10 text-sky-400';
  } else if (isError) {
    statusLabel = exitCode !== null ? `Failed · exit ${exitCode}` : 'Failed';
    statusClass = 'bg-rose-500/10 text-rose-400';
  }

  return (
    <div
      className="mt-1.5 w-full max-w-2xl overflow-hidden rounded-md border border-[hsl(var(--border)/0.55)] bg-[hsl(var(--foreground)/0.035)]"
      data-testid="command-output-pane"
      data-status={running ? 'running' : isError ? 'error' : 'done'}
    >
      <div className="flex items-center gap-2 border-b border-[hsl(var(--border)/0.4)] px-3 py-1.5">
        <TerminalSquare className="size-3 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[hsl(var(--foreground)/0.8)]"
          title={command}
        >
          {shortenCommand(command)}
        </span>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium',
            statusClass,
          )}
          data-testid="command-status-pill"
        >
          {running && <Loader2 className="size-2.5 animate-spin" />}
          {statusLabel}
        </span>
        {isError && hasOutput && (
          <button
            type="button"
            onClick={() => setShowOutput((v) => !v)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[10px] text-muted-foreground hover:text-foreground"
            aria-expanded={showOutput}
            data-testid="command-output-toggle"
          >
            output
            <ChevronDown
              className={cn('size-3 transition-transform', showOutput && 'rotate-180')}
              aria-hidden
            />
          </button>
        )}
      </div>
      {isError && errorLine && (
        <div
          className="truncate border-b border-[hsl(var(--border)/0.4)] px-3 py-1 font-mono text-[11px] text-rose-400"
          title={errorLine}
          data-testid="command-error-line"
        >
          {errorLine}
        </div>
      )}
      {showFull && (
        <pre
          ref={scrollRef}
          className="tool-result-scroll bg-code-block text-code-block m-0 max-h-56 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words"
          data-testid="command-full-output"
          onWheel={(e) => {
            if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
          }}
        >
          {body}
        </pre>
      )}
    </div>
  );
}
