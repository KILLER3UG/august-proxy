import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import {
  Terminal,
  FileText,
  Search,
  Code,
  Database,
  Plug,
  Puzzle,
  Wrench
} from 'lucide-react';

export function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  
  // Terminal / shell commands
  if (name.includes('run_command') || name.includes('bash') || name.includes('powershell') || name.includes('cmd') || name.includes('execute')) {
    return Terminal;
  }
  
  // File operations
  if (name.includes('read_file') || name.includes('write_file') || name.includes('cat') || name.includes('open') || name.includes('file') || name.includes('replace_file')) {
    return FileText;
  }
  
  // Web search
  if (name.includes('search') || name.includes('web_search') || name.includes('google') || name.includes('bing') || name.includes('url')) {
    return Search;
  }
  
  // Code execution
  if (name.includes('code') || name.includes('execute_code') || name.includes('python') || name.includes('node') || name.includes('run_code')) {
    return Code;
  }
  
  // Database queries
  if (name.includes('db') || name.includes('database') || name.includes('query') || name.includes('sql') || name.includes('postgres') || name.includes('mongo')) {
    return Database;
  }
  
  // MCP
  if (name.includes('mcp') || name.includes('protocol')) {
    return Plug;
  }
  
  // API call
  if (name.includes('api') || name.includes('http') || name.includes('fetch') || name.includes('request')) {
    return Plug;
  }
  
  // General skill
  if (name.includes('skill') || name.includes('workflow')) {
    return Puzzle;
  }
  
  // Default fallback
  return Wrench;
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
  const label = isCommand
    ? `Executed: ${tool.name.replace(/^@/, '')}`
    : tool.name;
  const ToolIcon = getToolIcon(tool.name);

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
          <ToolIcon className="size-3.5 shrink-0 text-primary" />
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
