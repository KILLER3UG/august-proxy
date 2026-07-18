/**
 * SubagentTimeline — shared body for the subagent detail modal.
 *
 * Running: live thinking / tools.
 * Settled: ActivitySummary (collapsed) over pre-final work + final response.
 */

import { useMemo, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { MessageBlock } from '@/types/chat';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';
import { Markdown } from '@/sections/chat/ChatMarkdown';
import { ToolCallItem } from '@/components/chat/ToolCallItem';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { classifyTool } from '@/lib/tool-classify';
import { getAgentRoleLabel } from '@/lib/tool-labels';
import {
  isSubagentToolName,
  SUBAGENT_STATUS_LABEL,
  type SubagentPromptEntry,
} from '@/components/chat/subagent-tools';

export function splitSubagentBlocks(blocks: MessageBlock[]): {
  bodyBlocks: MessageBlock[];
  finalOutput: MessageBlock | null;
} {
  let lastIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'finalOutput') {
      lastIdx = i;
      break;
    }
  }
  return {
    bodyBlocks: blocks.filter((_, i) => i !== lastIdx),
    finalOutput: lastIdx >= 0 ? blocks[lastIdx] : null,
  };
}

interface SubagentTimelineProps {
  state: SubagentBlockState;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  /** Open a nested subagent in the parent detail modal. */
  onOpenAgent?: (jobId: string) => void;
}

export function SubagentTimeline({
  state,
  subBlocks,
  subPrompts,
  modelLabel,
  onOpenAgent,
}: SubagentTimelineProps) {
  const friendlyRole = useMemo(
    () => getAgentRoleLabel(state.agentId),
    [state.agentId],
  );

  const { bodyBlocks, finalOutput } = useMemo(
    () => splitSubagentBlocks(state.blocks),
    [state.blocks],
  );

  const isRunning = state.status === 'running';
  const isFailed = state.status === 'failed';

  const activityCounts = useMemo(() => {
    let thoughtCount = 0;
    let viewedCount = 0;
    let editedCount = 0;
    let ranCount = 0;
    let usedCount = 0;
    for (const block of bodyBlocks) {
      if (block.type === 'thinking') {
        thoughtCount++;
        continue;
      }
      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const bucket = classifyTool(block.tool.name);
        if (bucket === 'view') viewedCount++;
        else if (bucket === 'edit') editedCount++;
        else if (bucket === 'run') ranCount++;
        else usedCount++;
      }
    }
    return { thoughtCount, viewedCount, editedCount, ranCount, usedCount };
  }, [bodyBlocks]);

  const renderInner = (block: MessageBlock): ReactNode => (
    <SubagentInnerBlock
      key={block.id}
      block={block}
      subBlocks={subBlocks}
      subPrompts={subPrompts}
      modelLabel={modelLabel}
      onOpenAgent={onOpenAgent}
    />
  );

  if (state.blocks.length === 0) {
    return (
      <div className="space-y-3">
        {state.task ? (
          <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
            <Markdown content={state.task} variant="assistant" />
          </div>
        ) : null}
        <div className="text-[12px] text-muted-foreground/70 italic">
          {isRunning ? `${friendlyRole} is starting…` : 'No output recorded.'}
        </div>
        {isFailed && state.error ? (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
            {state.error}
          </div>
        ) : null}
      </div>
    );
  }

  if (isRunning) {
    return (
      <div className="space-y-2" data-slot="subagent-timeline-live">
        {state.task ? (
          <div className="min-w-0 text-sm text-foreground/90 chat-message-text pb-2 border-b border-border/40">
            <Markdown content={state.task} variant="assistant" />
          </div>
        ) : null}
        {bodyBlocks.map(renderInner)}
        {finalOutput?.content ? (
          <div className="min-w-0 text-sm text-foreground/90 chat-message-text">
            <Markdown content={finalOutput.content} />
          </div>
        ) : null}
      </div>
    );
  }

  const activityBody = bodyBlocks.length > 0 ? (
    <div className="space-y-2">{bodyBlocks.map(renderInner)}</div>
  ) : null;

  return (
    <div className="space-y-3" data-slot="subagent-timeline-done">
      {activityBody ? (
        <ActivitySummary {...activityCounts} defaultOpen={false}>
          {activityBody}
        </ActivitySummary>
      ) : null}
      {finalOutput?.content ? (
        <div
          className="min-w-0 text-sm text-foreground/90 chat-message-text"
          data-slot="subagent-final-output"
        >
          <Markdown content={finalOutput.content} />
        </div>
      ) : !isFailed ? (
        <div className="text-[12px] text-muted-foreground/70 italic">
          No final response recorded.
        </div>
      ) : null}
      {isFailed && state.error ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
          {state.error}
        </div>
      ) : null}
    </div>
  );
}

function NestedAgentRows({
  agents,
  modelLabel,
  onOpenAgent,
}: {
  agents: SubagentBlockState[];
  modelLabel?: string;
  onOpenAgent?: (jobId: string) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <div className="mt-1 ml-1 space-y-0.5" data-slot="subagent-nested-list">
      <div className="text-[11px] text-muted-foreground/70 px-1">Checked to do list</div>
      {agents.map((agent) => {
        const title = agent.task?.trim() || getAgentRoleLabel(agent.agentId);
        return (
          <button
            key={agent.jobId}
            type="button"
            onClick={() => onOpenAgent?.(agent.jobId)}
            className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-white/[0.03]"
            data-subagent-id={agent.jobId}
          >
            <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center">
              {agent.status === 'running' ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : (
                <span
                  className={
                    agent.status === 'completed'
                      ? 'size-2 rounded-full bg-emerald-500'
                      : agent.status === 'failed'
                        ? 'size-2 rounded-full bg-destructive'
                        : 'size-2 rounded-full bg-muted-foreground/50'
                  }
                />
              )}
            </span>
            <span className="min-w-0 flex-1 text-[12px] leading-5">
              <span className="text-foreground/90">{title}</span>
              {modelLabel ? (
                <span className="text-muted-foreground/60"> {modelLabel}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/70">
              {SUBAGENT_STATUS_LABEL[agent.status]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SubagentInnerBlock({
  block,
  subBlocks,
  subPrompts,
  modelLabel,
  onOpenAgent,
}: {
  block: MessageBlock;
  subBlocks?: Map<string, SubagentBlockState>;
  subPrompts?: Map<string, SubagentPromptEntry>;
  modelLabel?: string;
  onOpenAgent?: (jobId: string) => void;
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
    return (
      <div className="text-[12px] text-foreground/90 chat-message-text">
        <Markdown content={block.content || ''} />
      </div>
    );
  }
  if (block.type === 'toolCall' || block.type === 'command') {
    if (!block.tool) return null;

    const isSubagentCall = isSubagentToolName(block.tool.name);
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
          <NestedAgentRows
            agents={subagentContainers}
            modelLabel={modelLabel}
            onOpenAgent={onOpenAgent}
          />
        )}
      </div>
    );
  }
  return null;
}
