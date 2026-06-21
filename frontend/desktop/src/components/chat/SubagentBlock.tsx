/**
 * SubagentBlock — nested renderer for sub-agent (`august__spawn_subagent` /
 * `august__run_team`) progress. Appears under the parent `tool_call` block
 * in the assistant message, indented inside a left rail so the parent/child
 * relationship is visible at a glance.
 *
 * The block's contents are the sub-agent's own `blocks` array, rendered
 * through the same reducer used for the parent assistant message (thinking,
 * final_output, tool_call, tool_result, command).
 */

import { useState, useEffect, useMemo, type ReactNode, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertCircle, Bot, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessageBlock } from '@/sections/chat/ChatThread';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { ToolCallItem } from '@/components/chat/ToolCallItem';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';

interface SubagentBlockProps {
  state: SubagentBlockState;
}

const STATUS_LABEL: Record<SubagentBlockState['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_CLASS: Record<SubagentBlockState['status'], string> = {
  running: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30',
  completed: 'text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30',
  failed: 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/30',
  cancelled: 'text-muted-foreground bg-muted/40 border-border',
};

function StatusIcon({ status }: { status: SubagentBlockState['status'] }) {
  if (status === 'running') return <Loader2 className="size-3 animate-spin" />;
  if (status === 'completed') return <CheckCircle2 className="size-3" />;
  if (status === 'failed') return <AlertCircle className="size-3" />;
  return <StopCircle className="size-3" />;
}

export function SubagentBlock({ state }: SubagentBlockProps): ReactElement {
  // Persist expand/collapse per job id across re-renders.
  const expandKey = `chat_subagent_expanded_${state.jobId}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(expandKey);
      return saved == null ? true : saved === '1';
    } catch (_) { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(expandKey, expanded ? '1' : '0'); } catch (_) {}
  }, [expandKey, expanded]);

  // Live elapsed timer while the sub-agent is running.
  const [elapsed, setElapsed] = useState<number>(0);
  useEffect(() => {
    if (state.status !== 'running') {
      setElapsed(state.finishedAt && state.startedAt
        ? Math.max(0, Math.round((state.finishedAt - state.startedAt) / 100) / 10)
        : 0);
      return;
    }
    const startedAt = state.startedAt || Date.now();
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 100) / 10);
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [state.status, state.startedAt, state.finishedAt]);

  const headerLabel = useMemo(() => {
    const parts: string[] = [];
    if (state.agentId) parts.push(state.agentId);
    if (state.scope) parts.push(`scope=${state.scope}`);
    if (state.depth != null) parts.push(`depth=${state.depth}`);
    return parts.join(' · ') || 'subagent';
  }, [state.agentId, state.scope, state.depth]);

  return (
    <div
      className={cn(
        'mt-2 ml-3 pl-3 border-l-2 border-border/60',
        'transition-colors',
      )}
      data-subagent-id={state.jobId}
      data-subagent-status={state.status}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
          'hover:bg-muted/40 transition-colors',
        )}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground shrink-0" />
        )}
        <Bot className="size-3 text-primary shrink-0" />
        <span className="font-medium text-[11px] text-foreground">Sub-agent</span>
        <span className="font-mono text-[10px] text-muted-foreground truncate flex-1 min-w-0">
          {headerLabel}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5',
            'text-[9px] uppercase tracking-wider font-semibold',
            STATUS_CLASS[state.status],
          )}
        >
          <StatusIcon status={state.status} />
          {STATUS_LABEL[state.status]}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums w-12 text-right">
          {elapsed > 0 ? `${elapsed.toFixed(1)}s` : ''}
        </span>
      </button>

      {state.task && (
        <div className="mt-1 ml-6 text-[11px] text-muted-foreground line-clamp-2 italic">
          {state.task}
        </div>
      )}

      {expanded && (
        <div className="mt-1 ml-6 space-y-2">
          {state.blocks.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/60 italic py-1">
              {state.status === 'running' ? 'Sub-agent is starting…' : 'No sub-agent output recorded.'}
            </div>
          ) : (
            state.blocks.map((block) => (
              <SubagentInnerBlock key={block.id} block={block} />
            ))
          )}
          {state.status === 'failed' && state.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">
              {state.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Render a sub-agent inner block — same kinds as the parent message's
 *  blocks array. Kept here so the sub-agent container is self-contained
 *  and doesn't depend on the parent assistant-message reducer. */
function SubagentInnerBlock({ block }: { block: MessageBlock }): ReactNode {
  if (block.type === 'thinking') {
    return (
      <ThinkingDisclosure pending={false}>
        <div className="pl-3 border-l border-foreground/15 py-1 chat-thought-text text-[11px]">
          <Markdown content={block.content || ''} />
        </div>
      </ThinkingDisclosure>
    );
  }
  if (block.type === 'final_output') {
    return (
      <div className="text-[12px] text-foreground/90 chat-message-text">
        <Markdown content={block.content || ''} />
      </div>
    );
  }
  if (block.type === 'tool_call' || block.type === 'command') {
    if (!block.tool) return null;
    return (
      <ToolCallItem
        tool={{
          id: block.tool.id,
          name: block.tool.name,
          status: block.tool.status,
          context: block.tool.context,
          summary: block.tool.summary,
          error: block.tool.error,
          duration: block.tool.duration,
          startedAt: block.tool.startedAt,
        }}
      />
    );
  }
  return null;
}
