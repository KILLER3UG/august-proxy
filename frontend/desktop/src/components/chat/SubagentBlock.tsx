/**
 * SubagentBlock — nested renderer for sub-agent (`august__spawn_subagent` /
 * `august__run_team`) progress. Appears under the parent `toolCall` block
 * in the assistant message, indented inside a left rail so the parent/child
 * relationship is visible at a glance.
 *
 * The block's contents are the sub-agent's own `blocks` array, rendered
 * through the same reducer used for the parent assistant message (thinking,
 * final_output, toolCall, tool_result, command).
 *
 * Structural layout (matches Cursor's own sub-agent card):
 *   🤖 SubAgent Explore · Audit git state, branches…      [Completed] 1.2s ⌄
 *     ┌─────────────────────────────────┐
 *     │ PROMPT                          │  (own scroll)
 *     │ …task text…                     │
 *     └─────────────────────────────────┘
 *     Tool call 1
 *     Tool call 2
 *     ┌─────────────────────────────────┐
 *     │ SUBAGENT OUTPUT                 │  (own scroll)
 *     │ …final summary…                 │
 *     └─────────────────────────────────┘
 * The header itself is unbordered/flat; only the Prompt and Subagent
 * output sections get their own rounded, bordered, independently
 * scrollable boxes — long prompts don't push the output out of view.
 *
 * The outer left rail (`border-l-2`) is owned by ChatThread's wrapper
 * (which already provides the `ml-3` indent that aligns this block with
 * the sibling `PromptDisclosure` chip).
 */

import { useState, useEffect, useMemo, type ReactNode, type ReactElement } from 'react';
import { Bot, ChevronDown, Loader2, CheckCircle2, AlertCircle, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessageBlock } from '@/types/chat';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { ToolCallItem } from '@/components/chat/ToolCallItem';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { getAgentRoleLabel } from '@/lib/tool-labels';

/** Sub-agent prompt payload stored on ChatThread's `subagentPrompts` map. */
export interface SubagentPromptEntry {
  content: string;
  systemPrompt: string;
  userMessage: string;
  tokens: number;
  subagentId?: string;
  jobId?: string;
}

const SUBAGENT_TOOL_NAMES = new Set([
  'august__spawn_subagent',
  'august_spawn_subagent',
  'workbench_spawn_subagent',
  // Registered bare (no `august__`/`workbench_` prefix) in
  // `agent_tools.py` / `spawn_subagents_tool.py`.
  'spawn_subagent',
  'spawn_subagents',
  'invoke_subagent',
  'august__run_team',
  'workbench_run_team',
]);

function isSubagentToolName(name?: string): boolean {
  if (!name) return false;
  const clean = name.replace(/^@/, '');
  return SUBAGENT_TOOL_NAMES.has(clean);
}

interface SubagentBlockProps {
  state: SubagentBlockState;
  /**
   * Maps for nested sub-agent dispatch. When a `toolCall` inside this block
   * is itself a sub-agent spawn, we look up its child container + prompt and
   * render them indented under the tool row (outside the final output box).
   */
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
}

const STATUS_LABEL: Record<SubagentBlockState['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_CLASS: Record<SubagentBlockState['status'], string> = {
  running: 'text-warning bg-warning/10 border-warning/30',
  completed: 'text-success bg-success/10 border-success/30',
  failed: 'text-danger bg-danger/10 border-danger/30',
  cancelled: 'text-muted-foreground bg-muted/40 border-border',
};

function StatusIcon({ status }: { status: SubagentBlockState['status'] }) {
  if (status === 'running') return <Loader2 className="size-3 animate-spin" />;
  if (status === 'completed') return <CheckCircle2 className="size-3" />;
  if (status === 'failed') return <AlertCircle className="size-3" />;
  return <StopCircle className="size-3" />;
}

export function SubagentBlock({ state, subBlocks, subPrompts }: SubagentBlockProps): ReactElement {
  // Persist expand/collapse per job id across re-renders.
  const expandKey = `chat_subagent_expanded_${state.jobId}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(expandKey);
      return saved === '1';
    } catch { /* silent */ return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(expandKey, expanded ? '1' : '0'); } catch { /* silent */ }
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

  const friendlyRole = useMemo(
    () => getAgentRoleLabel(state.agentId),
    [state.agentId],
  );

  // Split `state.blocks` into body (tools, thinking, intermediate text) and
  // the LAST `finalOutput` chunk, which becomes the boxed summary at the
  // bottom. Body blocks render in their original chronological order above
  // the box.
  const { bodyBlocks, finalOutput } = useMemo(() => {
    let lastIdx = -1;
    for (let i = state.blocks.length - 1; i >= 0; i--) {
      if (state.blocks[i].type === 'finalOutput') { lastIdx = i; break; }
    }
    return {
      bodyBlocks: state.blocks.filter((_, i) => i !== lastIdx),
      finalOutput: lastIdx >= 0 ? state.blocks[lastIdx] : null,
    };
  }, [state.blocks]);

  const collapsedSummary = useMemo(() => {
    const parts: string[] = [];
    if (state.task) {
      const task = state.task.trim();
      parts.push(task.length > 72 ? `${task.slice(0, 69).trimEnd()}…` : task);
    } else if (bodyBlocks.length > 0 || finalOutput) {
      parts.push(
        bodyBlocks.length > 0
          ? `${bodyBlocks.length} step${bodyBlocks.length === 1 ? '' : 's'}`
          : 'Completed',
      );
    } else if (state.status === 'running') {
      parts.push('Working…');
    }
    return parts.join(' · ');
  }, [state.task, state.status, bodyBlocks.length, finalOutput]);

  return (
    <div
      className={cn(
        'mt-1.5 max-w-2xl',
        'transition-colors',
      )}
      data-subagent-id={state.jobId}
      data-subagent-status={state.status}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left',
          'hover:bg-white/[0.03] transition-colors',
        )}
        aria-expanded={expanded}
      >
        <Bot className="size-3.5 text-muted-foreground/60 shrink-0" />
        <span className="min-w-0 flex-1 text-[12px] leading-5 truncate">
          <span className="text-info/80">SubAgent</span>
          <span className="text-foreground font-semibold"> {friendlyRole}</span>
          {collapsedSummary && (
            <span className="text-muted-foreground/70"> · {collapsedSummary}</span>
          )}
        </span>
        {state.status !== 'completed' && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 shrink-0',
              'text-[9px] font-medium tracking-wide',
              STATUS_CLASS[state.status],
            )}
          >
            <StatusIcon status={state.status} />
            {STATUS_LABEL[state.status]}
          </span>
        )}
        {elapsed > 0 && (
          <span className="tool-row-meta tabular-nums text-muted-foreground/60 shrink-0">
            {elapsed.toFixed(1)}s
          </span>
        )}
        <ChevronDown
          className={cn(
            'size-3 text-muted-foreground/60 shrink-0 transition-transform duration-150',
            !expanded && '-rotate-90',
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 ml-5 space-y-2">
          {state.task && (
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 max-h-56 overflow-y-auto">
              <div className="mb-1 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/55">
                Prompt
              </div>
              <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
                <Markdown content={state.task} variant="assistant" />
              </div>
            </div>
          )}
          {state.blocks.length === 0 ? (
            <div className="text-[11px] text-muted-foreground/60 italic py-1">
              {state.status === 'running' ? `${friendlyRole} is starting…` : 'No output recorded.'}
            </div>
          ) : (
            <>
              {bodyBlocks.map((block) => (
                <SubagentInnerBlock
                  key={block.id}
                  block={block}
                  subBlocks={subBlocks}
                  subPrompts={subPrompts}
                />
              ))}
              {finalOutput && (
                <div
                  className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 max-h-56 overflow-y-auto"
                  data-slot="subagent-final-output"
                >
                  <div className="mb-1 text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/55">
                    Subagent output
                  </div>
                  <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
                    <Markdown content={finalOutput.content || ''} />
                  </div>
                </div>
              )}
            </>
          )}
          {state.status === 'failed' && state.error && (
            <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
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
function SubagentInnerBlock({
  block,
  subBlocks,
  subPrompts,
}: {
  block: MessageBlock;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
}): ReactNode {
  if (block.type === 'thinking') {
    return (
      <ThinkingDisclosure pending={false}>
        <div className="pl-3 chat-rail py-1 chat-thought-text text-[11px]">
          <Markdown content={block.content || ''} />
        </div>
      </ThinkingDisclosure>
    );
  }
  if (block.type === 'finalOutput') {
    // Earlier finalOutput chunks (when multiple streamed chunks exist)
    // render as bare Markdown in the body. The LAST chunk is rendered as a
    // box by the caller.
    return (
      <div className="text-[12px] text-foreground/90 chat-message-text">
        <Markdown content={block.content || ''} />
      </div>
    );
  }
  if (block.type === 'toolCall' || block.type === 'command') {
    if (!block.tool) return null;

    const isSubagentCall = isSubagentToolName(block.tool.name);
    // If this tool call itself spawns a sub-agent, look up the matching
    // prompt + child container so we can render them indented under the
    // tool row (outside the final output box).
    const promptEntries = isSubagentCall && block.tool.id && subPrompts
      ? Array.from(subPrompts.entries())
          .filter(([k]) => k === block.tool!.id)
          .map(([, v]) => v)
      : [];
    const subagentContainers = isSubagentCall && block.tool.id && subBlocks
      ? Array.from(subBlocks.values())
          .filter((s) => s.parentToolId === block.tool!.id)
          .sort((a, b) => a.startedAt - b.startedAt)
      : [];

    return (
      <div className="space-y-1.5">
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
        {promptEntries.length > 0 && (
          <div className="ml-3 flex flex-col gap-1">
            {promptEntries.map((p, pi) => (
              <PromptDisclosure
                key={`${block.tool!.id}-prompt-${pi}`}
                content={p.content}
                tokens={p.tokens}
                label={p.subagentId
                  ? `SUB-AGENT PROMPT · ${p.subagentId}`
                  : 'SUB-AGENT PROMPT'}
              />
            ))}
          </div>
        )}
        {subagentContainers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {subagentContainers.map((s) => (
              <SubagentBlock
                key={s.jobId}
                state={s}
                subBlocks={subBlocks}
                subPrompts={subPrompts}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  return null;
}