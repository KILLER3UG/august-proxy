import { useEffect, useState } from 'react';
import { Check, Loader2, FileSearch } from 'lucide-react';
import { cn, fmtElapsed } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { DiffView } from '@/components/chat/DiffView';
import { confirmWorkbenchMutation } from '@/api/workbench';
import { visibleProgress, type ProgressEntry } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';

/**
 * Extract a filename hint from a tool's JSON context (best-effort).
 * Returns null if the context isn't JSON or no filename-shaped key is present.
 */
function extractFilename(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (typeof parsed === 'string') return parsed;
    for (const key of ['file_path', 'path', 'filename', 'file', 'filepath', 'notebook_path', 'target_file']) {
      const v = parsed[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Best-effort extraction of the actual command string for run_command tools.
 * The workbench stores tool input as a JSON-encoded `context` string, so
 * we look for an obvious `command` (or `cmd` / `shell_command`) field.
 */
function extractCommand(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      for (const key of ['command', 'cmd', 'shell_command', 'shellCommand', 'script']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

/**
 * Best-effort extraction of the agent_id parameter from a tool's context.
 */
function extractAgentId(context?: string): string | null {
  if (!context) return null;
  try {
    const parsed = JSON.parse(context);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['agent_id', 'agent', 'subagent_type']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  } catch {
    /* not JSON — ignore */
  }
  return null;
}

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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}

// Above this length the per-character shimmer animation becomes visually
// noisy and slow. Used to decide between the animated "thinking-text" path
// and the plain monospace fallback.
const LONG_LABEL_THRESHOLD = 40;
function isLongLabel(label: string): boolean {
  return label.length > LONG_LABEL_THRESHOLD;
}

/**
 * Best-effort extraction of diff inputs from a tool's args / result.
 * Returns a payload compatible with <DiffView> props.
 */
function extractDiffData(tool: { context?: string; result?: unknown; name?: string }): {
  diff?: string;
  oldContent?: string;
  newContent?: string;
} | null {
  const isEditLike = /^(write_file|edit_file|replace_file|apply_patch|create_file|str_replace|@write_file|@edit_file|@replace_file|@apply_patch|@create_file|@str_replace)/i.test(
    (tool.name || '').replace(/^@/, '')
  );
  if (!isEditLike) return null;

  // 1) Pre-formatted diff (most common — workbench already computes it)
  if (tool.context && typeof tool.context === 'string' && /^[+\-@]/.test(tool.context.trim())) {
    // The context itself looks like a diff
    return { diff: tool.context };
  }
  if (typeof (tool as { inline_diff?: string }).inline_diff === 'string') {
    return { diff: (tool as { inline_diff?: string }).inline_diff };
  }

  // 2) Inspect args and result for old/new pairs
  let args: Record<string, unknown> = {};
  if (tool.context) {
    try { args = JSON.parse(tool.context) as Record<string, unknown>; } catch { /* ignore */ }
  }
  const result = (tool as { result?: unknown }).result;

  // Result: { diff: '...' } or { patch: '...' } or the result itself is a string
  if (typeof result === 'string' && (result.includes('--- ') || result.includes('+++ ') || result.startsWith('@@'))) {
    return { diff: result };
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.diff === 'string') return { diff: r.diff };
    if (typeof r.patch === 'string') return { diff: r.patch };
    if (typeof r.unified_diff === 'string') return { diff: r.unified_diff };
    if (typeof r.old === 'string' && typeof r.new === 'string') {
      return { oldContent: r.old, newContent: r.new };
    }
    if (typeof r.oldContent === 'string' && typeof r.newContent === 'string') {
      return { oldContent: r.oldContent, newContent: r.newContent };
    }
  }

  // 3) Args: { old_string, new_string } / { find, replace } / { patch } / { content } (no old → all added)
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const oldString = pick('old_string', 'find', 'old', 'oldContent');
  const newString = pick('new_string', 'replace', 'new', 'newContent', 'content', 'patch');
  if (oldString !== undefined && newString !== undefined) {
    return { oldContent: oldString, newContent: newString };
  }
  if (newString !== undefined) {
    // write_file with no old → show as all-added
    return { oldContent: '', newContent: newString };
  }

  return null;
}

export interface ToolEntry {
  id: string;
  name: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  inline_diff?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  startedAt?: number;
  pendingApproval?: {
    message?: string;
    detail?: string;
    confirmationToken?: string;
  };
  /** For web_search: structured search hits to render as linked list */
  searchHits?: Array<{ title: string; url: string; snippet?: string }>;
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
    } else if ((tool.startedAt as any) instanceof Date) {
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


  const hasBody = !!(
    tool.context || tool.preview || tool.summary || tool.error || tool.inline_diff || tool.searchHits || tool.pendingApproval
  );
  const [approvalStatus, setApprovalStatus] = useState<'idle' | 'confirming' | 'confirmed'>('idle');

  const isRunning = tool.status === 'running';
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
  const labelTitle = isCommand && commandText && commandText.length > 120 ? commandText : undefined;
  const displayLabel = (elapsed !== undefined && elapsed >= 100) ? `${label} · ${formatTimer(elapsed)}` : label;

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
              isRunning && !isLongLabel(label) && 'shimmer text-foreground/55'
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
              <span className={cn('thinking-text', isRunning && 'animating')}>
                <span className="thinking-label">
                  {Array.from(displayLabel).map((ch, i) => (
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
          {tool.status === 'done' && (
            <span className="text-primary/80 text-[10px]">done</span>
          )}
          {tool.status === 'error' && (
            <span className="text-destructive text-[10px]">error</span>
          )}
        </span>
      </DisclosureRow>

      {open && hasBody && (
        <div className="pl-3 border-l border-foreground/15 ml-2.5 mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1">
          {tool.context && <Section label="context">{tool.context}</Section>}

          {(() => {
            const visible = progress ? visibleProgress(progress) : [];
            const total = progress?.length ?? 0;
            const overflow = Math.max(0, total - visible.length);
            if (visible.length === 0) return null;
            return (
              <div className="my-1.5 space-y-0.5" aria-label="Tool progress" data-tool-progress>
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">
                  <FileSearch size={10} />
                  <span>
                    {tool.status === 'running' ? 'Exploring' : 'Files'}
                  </span>
                </div>
                {visible.map((entry) => (
                  <div
                    key={entry.path}
                    className="flex items-center gap-1.5 text-[11px] truncate"
                    title={entry.path}
                  >
                    <span className="w-2.5 shrink-0 inline-flex justify-center">
                      {entry.status === 'reading' ? (
                        <Loader2 size={10} className="animate-spin text-blue-500" />
                      ) : (
                        <Check size={10} className="text-muted-foreground/50" />
                      )}
                    </span>
                    <span
                      className={cn(
                        'truncate font-mono',
                        entry.status === 'reading' ? 'text-blue-400 italic' : 'text-muted-foreground/60 line-through'
                      )}
                    >
                      {entry.status === 'reading' ? 'Reading ' : 'Read '}
                      {entry.path}
                    </span>
                  </div>
                ))}
                {overflow > 0 && (
                  <div className="text-[10px] text-muted-foreground/50 italic pl-4">
                    + {overflow} more
                  </div>
                )}
              </div>
            );
          })()}

          {tool.preview && tool.status === 'running' && (
            <Section label="streaming">
              {tool.preview}
              <span className="inline-block w-1.5 h-3 align-middle bg-foreground/40 ml-0.5 animate-pulse" />
            </Section>
          )}

          {(() => {
            const diffData = extractDiffData(tool);
            return diffData ? (
              <Section label="diff">
                <DiffView
                  diff={diffData.diff}
                  oldContent={diffData.oldContent}
                  newContent={diffData.newContent}
                />
              </Section>
            ) : null;
          })()}

          {tool.searchHits && tool.searchHits.length > 0 && (
            <Section label="results">
              <ol className="m-0 grid list-none gap-2 p-0">
                {tool.searchHits.map((hit, i) => (
                  <li key={i} className="grid min-w-0 gap-0.5">
                    {hit.url ? (
                      <a
                        href={hit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-primary hover:underline truncate block"
                      >
                        {hit.title || new URL(hit.url).hostname}
                      </a>
                    ) : (
                      <span className="text-xs font-medium text-foreground/90">{hit.title}</span>
                    )}
                    {hit.snippet && (
                      <p className="text-[10px] text-muted-foreground line-clamp-3 m-0">{hit.snippet}</p>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
          )}

          {tool.summary && (
            <Section label="result">
              <span className="text-foreground/90 whitespace-pre-wrap break-words">{tool.summary}</span>
            </Section>
          )}

          {tool.error && (
            <Section label="error" tone="error">
              <span className="text-destructive whitespace-pre-wrap">{tool.error}</span>
            </Section>
          )}

          {tool.pendingApproval && (
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/10 p-2">
              <div className="text-xs text-foreground/90">
                {tool.pendingApproval.message || 'This change needs approval before it can run.'}
              </div>
              {tool.pendingApproval.detail && (
                <div className="text-[11px] font-mono text-muted-foreground wrap-anywhere">
                  {tool.pendingApproval.detail}
                </div>
              )}
              <button
                type="button"
                disabled={approvalStatus !== 'idle'}
                className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60"
                onClick={() => {
                  const token = tool.pendingApproval?.confirmationToken;
                  if (!token) return;
                  setApprovalStatus('confirming');
                  confirmWorkbenchMutation(token, {
                    onText: ({ content }) => {
                      tool.summary = `${tool.summary || ''}\n${content}`.trim();
                    },
                    onToolUse: ({ id, name, input }) => {
                      tool.summary = `${tool.summary || ''}\nStarted ${name}: ${JSON.stringify(input || {})}`.trim();
                    },
                    onToolResult: ({ content }) => {
                      tool.summary = `${tool.summary || ''}\n${content}`.trim();
                    },
                    onError: ({ message }) => {
                      tool.error = message;
                    },
                    onDone: () => {
                      setApprovalStatus('confirmed');
                    },
                  });
                }}
              >
                {approvalStatus === 'confirming' ? 'Approving…' : 'Approve'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div className="flex gap-3 mt-1.5">
      <span
        className={`text-[10px] shrink-0 w-16 pt-0.5 ${
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground/60'
        }`}
      >
        {label}
      </span>
      <div className="flex-1 min-w-0 text-muted-foreground">{children}</div>
    </div>
  );
}
