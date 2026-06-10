import { useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Zap, Check, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';

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

const STATUS_TONE: Record<ToolEntry['status'], string> = {
  running: 'border-primary/40 bg-primary/[0.04]',
  done: 'border-border bg-muted/20',
  error: 'border-destructive/50 bg-destructive/[0.04]',
};

const BULLET_TONE: Record<ToolEntry['status'], string> = {
  running: 'text-primary',
  done: 'text-primary/80',
  error: 'text-destructive',
};

const TICK_MS = 500;

/**
 * ToolCallItem — renders one tool call as a collapsible card.
 * 
 * Collapsible tool call card with status icons, inline diffs, search results:
 *   ▸ ● read_file(path=/foo)                         2.3s
 * 
 * Uses lucide-react icons, live elapsed timer, inline diffs, and search results.
 */
export function ToolCallItem({ tool }: { tool: ToolEntry }) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? tool.status === 'error';

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (tool.status !== 'running') return;
    const id = window.setInterval(() => setNow(() => Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [tool.status]);

  const hasTimestamps = tool.startedAt !== undefined || tool.duration !== undefined;
  const elapsed = hasTimestamps
    ? fmtElapsed(tool.duration !== undefined ? tool.duration : (tool.startedAt ? Date.now() - tool.startedAt : 0))
    : null;

  const hasBody = !!(
    tool.context || tool.preview || tool.summary || tool.error || tool.inline_diff || tool.searchHits
  );

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`rounded-md border overflow-hidden ${STATUS_TONE[tool.status]}`} data-slot="tool-block">
      <button
        onClick={() => hasBody && setUserOverride(!open)}
        disabled={!hasBody}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-xs hover:bg-foreground/2 disabled:cursor-default transition"
      >
        {hasBody ? (
          <Chevron className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="size-3 shrink-0" />
        )}

        <Zap className={`size-3 shrink-0 ${BULLET_TONE[tool.status]}`} />

        <span className="font-mono font-medium shrink-0">{tool.name}</span>

        {tool.context && (
          <span className="font-mono text-muted-foreground truncate min-w-0 flex-1 text-[10px]">
            {tool.context}
          </span>
        )}

        {tool.status === 'running' && (
          <span className="inline-block size-2 rounded-full bg-primary animate-pulse shrink-0" title="running" />
        )}
        {tool.status === 'error' && (
          <AlertCircle className="size-3 shrink-0 text-destructive" aria-label="error" />
        )}
        {tool.status === 'done' && (
          <Check className="size-3 shrink-0 text-primary/80" aria-label="done" />
        )}

        {elapsed && (
          <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
            {elapsed}
          </span>
        )}
      </button>

      {open && hasBody && (
        <div className="border-t border-border/60 px-3 py-2 space-y-2 text-xs font-mono">
          {tool.context && <Section label="context">{tool.context}</Section>}

          {tool.preview && tool.status === 'running' && (
            <Section label="streaming">
              {tool.preview}
              <span className="inline-block w-1.5 h-3 align-middle bg-foreground/40 ml-0.5 animate-pulse" />
            </Section>
          )}

          {tool.inline_diff && (
            <Section label="diff">
              <pre className="whitespace-pre overflow-x-auto text-[11px] leading-snug">
                {colorizeDiff(tool.inline_diff)}
              </pre>
            </Section>
          )}

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
    <div className="flex gap-3">
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

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 1) return `${Math.round(ms)}ms`;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Colorize unified-diff lines for the inline diff section. */
function colorizeDiff(diff: string): React.ReactNode {
  return diff.split('\n').map((line, i) => (
    <div key={i} className={diffLineClass(line)}>
      {line || '\u00A0'}
    </div>
  ));
}

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-green-600 dark:text-green-400';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-destructive';
  if (line.startsWith('@@')) return 'text-primary';
  return 'text-muted-foreground/70';
}
