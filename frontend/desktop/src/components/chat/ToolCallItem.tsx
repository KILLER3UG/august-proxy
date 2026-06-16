import { useEffect, useState } from 'react';
import { cn, fmtElapsed } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon } from '@/components/ui/FileIcon';
import { DiffView } from '@/components/chat/DiffView';

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
export function ToolCallItem({ tool }: { tool: ToolEntry }) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? tool.status === 'error';

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tool.status !== 'running') return;
    const id = window.setInterval(() => setNow(() => Date.now()), 500);
    return () => window.clearInterval(id);
  }, [tool.status]);

  const hasTimestamps = tool.startedAt !== undefined || tool.duration !== undefined;
  const elapsed = hasTimestamps
    ? fmtElapsed(tool.duration !== undefined ? tool.duration : (tool.startedAt ? Date.now() - tool.startedAt : 0))
    : null;

  const hasBody = !!(
    tool.context || tool.preview || tool.summary || tool.error || tool.inline_diff || tool.searchHits
  );

  const isRunning = tool.status === 'running';
  const isCommand = tool.name.startsWith('@run_command') || tool.name.startsWith('run_command');
  // Strip the @ prefix that the workbench sometimes prepends so the icon
  // mapper matches the canonical tool name (e.g. "read_file" not "@read_file").
  const toolNameForIcon = tool.name.replace(/^@/, '');
  const label = isCommand
    ? `Executed: ${toolNameForIcon}`
    : toolNameForIcon;
  const filename = !isCommand ? extractFilename(tool.context) : null;

  return (
    <div className="text-xs text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setUserOverride(!open) : undefined}
        open={open && hasBody}
        trailing={
          elapsed && (
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
              {elapsed}
            </span>
          )
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {filename ? (
            <FileIcon name={filename} size={14} className="shrink-0" />
          ) : (
            <ToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-xs font-medium leading-5',
              isRunning && 'shimmer text-foreground/55'
            )}
          >
            <span className={cn('thinking-text', isRunning && 'animating')}>
              <span className="thinking-label">
                {Array.from(label).map((ch, i) => (
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
