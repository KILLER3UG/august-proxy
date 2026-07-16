import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ToolCallItem as ToolCallItemComp,
} from '@/components/chat/ToolCallItem';
import { ToolIcon as NewToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon as NewFileIcon } from '@/components/ui/FileIcon';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { visibleProgress } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import type { ChatMessage } from '@/types/chat';

/** Renders a flat list of tool call items with per-tool progress. */
export function ToolBlock({
  tools,
  toolProgress,
}: {
  tools: NonNullable<ChatMessage['tools']>;
  toolProgress: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
}) {
  return (
    <>
      {tools.map((tool) => (
        <ToolCallItemComp
          key={tool.id}
          tool={tool}
          progress={toolProgress.get(tool.id)}
        />
      ))}
    </>
  );
}

/**
 * Legacy role:'tool' message card — expandable args/result with optional
 * file-read progress under the disclosure header.
 */
export function ToolCallCard({
  tool,
  timestamp: _timestamp,
  progress,
}: {
  tool: NonNullable<ChatMessage['tool']>;
  timestamp: string;
  progress?: ReadonlyArray<{ path: string; status: 'reading' | 'read' }>;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(tool.args || tool.result);
  const toolNameForIcon = tool.name.replace(/^@/, '');
  const isCommand = toolNameForIcon === 'run_command' || tool.name.startsWith('@run_command');
  // Try to extract a filename hint from the args JSON for a brand-aware file icon.
  let legacyFilename: string | null = null;
  if (!isCommand && tool.args) {
    try {
      const parsed = JSON.parse(tool.args) as Record<string, unknown>;
      for (const key of ['filePath', 'file_path', 'path', 'filename', 'file', 'filepath']) {
        const v = parsed?.[key];
        if (typeof v === 'string' && v.length > 0) { legacyFilename = v; break; }
      }
    } catch { /* not JSON — ignore */ }
  }
  return (
    <div className="text-sm text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setOpen(!open) : undefined}
        open={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {legacyFilename ? (
            <NewFileIcon name={legacyFilename} size={14} className="shrink-0" />
          ) : (
            <NewToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-sm font-medium leading-5',
              tool.status === 'running' && 'shimmer text-foreground/55'
            )}
          >
            <span className={cn('thinking-text', tool.status === 'running' && 'animating')}>
              <span className="thinking-label">
                {Array.from(getToolLabel(tool.name)).map((ch, i) => (
                  <span
                    key={i}
                    className={cn('thinking-char', i === 0 && 'thinking-cap')}
                    style={{ animationDelay: `${i * 100}ms` }}
                  >
                    {ch}
                  </span>
                ))}
              </span>
              {tool.status === 'running' && (
                <span className="thinking-dots">
                  <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
                </span>
              )}
            </span>
          </span>
          {tool.status === 'done' && <span className="text-primary/80 text-[12px]">done</span>}
          {tool.status === 'error' && <span className="text-destructive text-[12px]">error</span>}
          {isCommand && typeof tool.result === 'string' && tool.result.includes('[sandbox:') && (
            <span
              className="text-[10px] uppercase tracking-wide text-muted-foreground/80 border border-border/50 rounded px-1"
              title={tool.result.includes('|unsandboxed]') ? 'Ran outside sandbox (approved)' : 'Ran inside sandbox'}
            >
              {tool.result.includes('|unsandboxed]') ? 'unsandboxed' : 'sandboxed'}
            </span>
          )}
        </span>
      </DisclosureRow>
      {(() => {
        const visible = progress ? visibleProgress(progress) : [];
        const total = progress?.length ?? 0;
        const overflow = Math.max(0, total - visible.length);
        if (visible.length === 0) return null;
        return (
          <div className="ml-3 mt-0.5 mb-1 space-y-0.5 chat-rail pl-2" aria-label="Tool progress" data-tool-progress>
            {visible.map((entry) => (
              <div key={entry.path} className="flex items-center gap-1.5 text-[11.5px] truncate" title={entry.path}>
                <span className="w-2.5 shrink-0 inline-flex justify-center">
                  {entry.status === 'reading' ? (
                    <Loader2 size={10} className="animate-spin text-info" />
                  ) : (
                    <Check size={10} className="text-muted-foreground/50" />
                  )}
                </span>
                <span
                  className={cn(
                    'truncate font-mono',
                    entry.status === 'reading' ? 'text-info italic' : 'text-muted-foreground/60 line-through'
                  )}
                >
                  {entry.status === 'reading' ? 'Reading ' : 'Read '}
                  {entry.path}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[10px] text-muted-foreground/50 italic pl-4">+ {overflow} more</div>
            )}
          </div>
        );
      })()}
      {open && hasBody && (
        <div className="mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1">
          {tool.args && (
            <pre className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-muted-foreground/70 break-words leading-relaxed chat-rail ml-2.5">
              {tool.args}
            </pre>
          )}
          {tool.result && (
            <div className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-foreground/80 break-words leading-relaxed chat-rail ml-2.5">
              {tool.result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
