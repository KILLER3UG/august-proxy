import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  ToolCallItemBody,
  extractAgentId,
  extractCommand,
  extractFilename,
} from '@/components/chat/ToolCallItem';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { ThoughtStep } from '@/components/chat/ThoughtStep';
import { ToolStepRow } from '@/components/chat/ToolStepRow';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { SubagentLaunchList } from '@/components/chat/SubagentLaunchList';
import { RecalledMemoryStep } from '@/components/chat/RecalledMemoryStep';
import { SavePointChip } from '@/components/chat/SavePointChip';
import { isSubagentToolName } from '@/components/chat/subagent-tools';
import { classifyTool } from '@/lib/tool-classify';
import { Markdown } from '../ChatMarkdown';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { SubagentBlockState } from '../chat-stream-manager';
import { buildProcessSummaryLine } from '@/lib/process-summary';
import {
  clearLiveActivity,
  publishLiveActivity,
  type LiveActivityItem,
  type LiveActivityKind,
} from '@/store/liveActivity';
import { getToolLabel } from '@/lib/tool-labels';
import { modelDisplayParts } from '../model-display';
import { resolveUiSessionId, resolveWorkbenchSessionId } from '../stream/session-id-map';

type DisplayBlock = MessageBlock;

function extractSubagentGoal(context?: string): string | undefined {
  if (!context) return undefined;
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    for (const key of ['goal', 'task', 'prompt', 'description', 'userMessage', 'message']) {
      const v = parsed?.[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    // spawn_subagents: first work item goal as fallback title
    const items = parsed?.workItems;
    if (Array.isArray(items) && items[0] && typeof items[0] === 'object') {
      const g = (items[0] as Record<string, unknown>).goal;
      if (typeof g === 'string' && g.trim()) return g.trim();
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

function toolStatusToSubagentStatus(
  status: string | undefined,
): SubagentBlockState['status'] {
  if (status === 'error') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'done' || status === 'completed') return 'completed';
  return 'running';
}

/** Build checklist rows from live subagent blocks and/or the parent tool call. */
function resolveChecklistAgents(
  toolBlocks: DisplayBlock[],
  subagentBlocks?: Map<string, SubagentBlockState>,
): SubagentBlockState[] {
  const toolIds = new Set(
    toolBlocks.map((b) => b.tool?.id).filter((id): id is string => !!id),
  );
  const toolGoals = new Set<string>();
  for (const block of toolBlocks) {
    const g = extractSubagentGoal(block.tool?.context);
    if (g) toolGoals.add(g);
    try {
      const parsed = block.tool?.context
        ? (JSON.parse(block.tool.context) as Record<string, unknown>)
        : null;
      const items = parsed?.workItems;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item && typeof item === 'object') {
            const goal = (item as Record<string, unknown>).goal;
            if (typeof goal === 'string' && goal.trim()) toolGoals.add(goal.trim());
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const fromLive = subagentBlocks
    ? Array.from(subagentBlocks.values())
        .filter((s) => {
          if (toolIds.has(s.parentToolId) || toolIds.has(s.jobId)) return true;
          // Mis-parented SSE rows still match when the goal text lines up.
          if (s.task && toolGoals.has(s.task)) return true;
          return false;
        })
        .sort((a, b) => a.startedAt - b.startedAt)
    : [];

  const withToolOutput = (agent: SubagentBlockState): SubagentBlockState => {
    const hasOutput = agent.blocks.some(
      (b) =>
        b.type === 'finalOutput' &&
        !!(b.content && String(b.content).trim()),
    );
    if (hasOutput) return agent;
    const tool =
      toolBlocks.find(
        (b) => b.tool?.id === agent.parentToolId || b.tool?.id === agent.jobId,
      )?.tool ||
      toolBlocks.find((b) => extractSubagentGoal(b.tool?.context) === agent.task)
        ?.tool;
    const summary = tool?.summary?.trim();
    if (!summary) return agent;
    return {
      ...agent,
      blocks: [
        ...agent.blocks,
        {
          id: `fo_${agent.jobId}`,
          type: 'finalOutput' as const,
          content: summary,
        },
      ],
      status:
        agent.status === 'running' && tool?.status === 'done'
          ? 'completed'
          : agent.status,
      finishedAt: agent.finishedAt || (tool?.status === 'done' ? Date.now() : undefined),
    };
  };

  if (fromLive.length > 0) return fromLive.map(withToolOutput);

  // Before SSE subagentStart arrives (or for singular tools), synthesize rows.
  const synthesized: SubagentBlockState[] = [];
  for (const block of toolBlocks) {
    const tool = block.tool;
    if (!tool?.id) continue;
    const agentId = extractAgentId(tool.context) || 'general';
    const goal = extractSubagentGoal(tool.context);
    const summary = tool.summary?.trim();
    const resultBlocks = summary
      ? [{ id: `fo_${tool.id}`, type: 'finalOutput' as const, content: summary }]
      : [];
    try {
      const parsed = tool.context
        ? (JSON.parse(tool.context) as Record<string, unknown>)
        : null;
      const items = parsed?.workItems;
      if (Array.isArray(items) && items.length > 0) {
        items.forEach((item, i) => {
          if (!item || typeof item !== 'object') return;
          const row = item as Record<string, unknown>;
          const rowGoal =
            typeof row.goal === 'string' ? row.goal : goal || `Work item ${i + 1}`;
          const rowAgent = typeof row.agentId === 'string' ? row.agentId : agentId;
          synthesized.push(
            withToolOutput({
              id: `sb_${tool.id}_${i}`,
              jobId: `${tool.id}_${i}`,
              parentToolId: tool.id,
              agentId: rowAgent,
              task: rowGoal,
              status: toolStatusToSubagentStatus(tool.status),
              startedAt: tool.startedAt || Date.now(),
              finishedAt: tool.status === 'done' ? Date.now() : undefined,
              blocks: resultBlocks,
            }),
          );
        });
        continue;
      }
    } catch {
      /* ignore */
    }
    synthesized.push(
      withToolOutput({
        id: `sb_${tool.id}`,
        jobId: tool.id,
        parentToolId: tool.id,
        agentId,
        task: goal,
        status: toolStatusToSubagentStatus(tool.status),
        startedAt: tool.startedAt || Date.now(),
        finishedAt: tool.status === 'done' ? Date.now() : undefined,
        blocks: resultBlocks,
      }),
    );
  }
  return synthesized;
}

function isFinalOutput(block: DisplayBlock): boolean {
  return (
    block.type === 'finalOutput' &&
    !!(block.content && String(block.content).trim())
  );
}

/** Split blocks into process (thinking/tools) vs final answer. */
function splitProcessAndFinal(blocks: DisplayBlock[]): {
  processBlocks: DisplayBlock[];
  finalBlocks: DisplayBlock[];
  hasFinalOutput: boolean;
} {
  let lastFinalIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (isFinalOutput(blocks[i])) lastFinalIdx = i;
  }
  const processBlocks: DisplayBlock[] = [];
  const finalBlocks: DisplayBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (isFinalOutput(block)) {
      if (i === lastFinalIdx) finalBlocks.push(block);
      else processBlocks.push({ ...block, type: 'thinking' });
    } else {
      processBlocks.push(block);
    }
  }
  return {
    processBlocks,
    finalBlocks,
    hasFinalOutput: finalBlocks.length > 0,
  };
}

export type SubagentPromptEntry = {
  content: string;
  systemPrompt: string;
  userMessage: string;
  tokens: number;
  subagentId?: string;
  jobId?: string;
};

export type ToolProgressMap = Map<
  string,
  ReadonlyArray<{ path: string; status: 'reading' | 'read' }>
>;

/** Interleaved process timeline (thinking/tools) + final answer. */
export function AssistantBlockTimeline({
  displayBlocks,
  message,
  isLast,
  streaming,
  showPendingThinking,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  modelId,
}: {
  displayBlocks: DisplayBlock[];
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  showPendingThinking: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  /** Parent session model id — shown as muted tag on subagent launch rows. */
  modelId?: string | null;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const liveSessionKey = resolveUiSessionId(routeSessionId || message.id);
  const modelLabel = modelId ? modelDisplayParts(modelId).name : undefined;

  const { processBlocks, finalBlocks, hasFinalOutput } =
    splitProcessAndFinal(displayBlocks);

  // Save-point chips: rendered between the process summary and the final
  // answer so they stay visible after the activity rail collapses.
  const checkpointBlocks = processBlocks.filter((b) => b.type === 'checkpoint');
  const wbSessionId = resolveWorkbenchSessionId(routeSessionId || message.id);

  // Id-keyed expand overrides; missing key → default from status.
  // Tools: running → open, else collapsed. Thoughts: open while generating,
  // collapse once the final answer exists (unless the user overrode).
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>(
    {},
  );

  // When the turn finishes, drop expand overrides so thoughts re-collapse.
  useEffect(() => {
    if (!streaming && hasFinalOutput) {
      setExpandOverrides({});
    }
  }, [streaming, hasFinalOutput]);

  const toggleExpand = (id: string, next: boolean) => {
    setExpandOverrides((prev) => ({ ...prev, [id]: next }));
  };

  const isToolExpanded = (toolId: string, status: string | undefined, toolName?: string) => {
    if (toolId in expandOverrides) return expandOverrides[toolId];
    // View/read tools stay collapsed — no content preview to expand into.
    if (toolName && classifyTool(toolName) === 'view') return false;
    return status === 'running';
  };

  const isThoughtExpanded = (thoughtId: string) => {
    if (thoughtId in expandOverrides) return expandOverrides[thoughtId];
    // Auto-expand only while this live turn is still in the process phase.
    return !!(isLast && streaming && !hasFinalOutput);
  };

  const thinkingParts = processBlocks
    .filter((b) => b.type === 'thinking' && b.content?.trim())
    .map((b) => b.content!.trim());
  const processSummary = buildProcessSummaryLine(thinkingParts);

  let toolsCount = 0;
  let viewedCount = 0;
  let editedCount = 0;
  let ranCount = 0;
  let usedCount = 0;
  for (const block of processBlocks) {
    if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
      toolsCount += 1;
      const bucket = classifyTool(block.tool.name);
      if (bucket === 'view') viewedCount += 1;
      else if (bucket === 'edit') editedCount += 1;
      else if (bucket === 'run') ranCount += 1;
      else usedCount += 1;
    }
  }
  // Coalesced consecutive thoughts count as one ThoughtStep in the UI.
  const coalescedThoughtCount = (() => {
    let n = 0;
    let i = 0;
    while (i < processBlocks.length) {
      if (processBlocks[i].type === 'thinking') {
        n += 1;
        while (i < processBlocks.length && processBlocks[i].type === 'thinking') i++;
        continue;
      }
      i++;
    }
    return n;
  })();

  const livePacked = !!(
    isLast &&
    streaming &&
    (processBlocks.length > 0 || showPendingThinking)
  );

  const { liveDetail, liveItems } = useMemo(() => {
    const items: LiveActivityItem[] = [];
    let liveDetail = '';
    for (const block of displayBlocks) {
      if (block.type === 'thinking' && block.content?.trim()) {
        const snippet = block.content.trim().replace(/\s+/g, ' ').slice(0, 80);
        items.push({
          id: block.id || `think_${items.length}`,
          kind: 'thinking',
          label: 'Thinking',
          detail: snippet,
          status: 'done',
          at: Date.now(),
        });
        liveDetail = `Thinking… ${snippet}${snippet.length >= 80 ? '…' : ''}`;
      }
      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const bucket = classifyTool(block.tool.name) as LiveActivityKind;
        const kind: LiveActivityKind =
          bucket === 'view' || bucket === 'edit' || bucket === 'run' ? bucket : 'tool';
        const label = getToolLabel(block.tool.name, {
          status: block.tool.status,
          command: extractCommand(block.tool.context) ?? undefined,
        });
        const detail =
          block.tool.preview?.slice(-120) ||
          block.tool.summary ||
          block.tool.context?.slice(0, 100) ||
          undefined;
        items.push({
          id: block.tool.id || block.id || `tool_${items.length}`,
          kind,
          label,
          detail,
          status:
            block.tool.status === 'error'
              ? 'error'
              : block.tool.status === 'running'
                ? 'running'
                : 'done',
          at: block.tool.startedAt || Date.now(),
        });
        if (block.tool.status === 'running' || !liveDetail) {
          liveDetail =
            kind === 'view'
              ? `Reading ${detail || 'files…'}`
              : kind === 'edit'
                ? `Editing ${detail || 'files…'}`
                : kind === 'run'
                  ? `Running ${detail || 'command…'}`
                  : // Prefer live progress summary (e.g. web_search fetch status).
                    detail || label;
        }
      }
    }
    if (showPendingThinking && !liveDetail) liveDetail = 'Thinking…';
    if (items.length > 0) {
      const last = items[items.length - 1];
      if (last.status === 'running' || (isLast && streaming)) {
        items[items.length - 1] = {
          ...last,
          status: last.status === 'error' ? 'error' : 'running',
        };
      }
    }
    return { liveDetail, liveItems: items };
  }, [displayBlocks, showPendingThinking, isLast, streaming]);

  useEffect(() => {
    if (!livePacked) {
      if (isLast && !streaming) {
        clearLiveActivity(liveSessionKey);
      }
      return;
    }
    publishLiveActivity({
      sessionId: liveSessionKey,
      headline: liveDetail || processSummary || 'Working…',
      items: liveItems,
    });
  }, [livePacked, liveSessionKey, liveDetail, liveItems, processSummary, isLast, streaming]);

  const renderProcessBlocks = (blocks: DisplayBlock[]) => {
    // Coalesce consecutive thinking into one ThoughtStep for cleaner rails.
    const nodes: ReactNode[] = [];
    let ti = 0;
    while (ti < blocks.length) {
      const block = blocks[ti];
      if (block.type === 'thinking') {
        const parts: string[] = [];
        const start = ti;
        while (ti < blocks.length && blocks[ti].type === 'thinking') {
          const c = (blocks[ti].content || '').trim();
          if (c) parts.push(c);
          ti++;
        }
        // Generating only when this coalesced thought is the last process
        // step and no final answer has landed yet.
        const isGenerating = !!(
          isLast &&
          streaming &&
          !hasFinalOutput &&
          ti === blocks.length
        );
        // "Done" on the last thought once thinking has finished and a final
        // answer exists (or the turn is no longer streaming).
        const hasMoreThoughts = blocks
          .slice(ti)
          .some((b) => b.type === 'thinking');
        const showDone =
          !isGenerating &&
          !hasMoreThoughts &&
          (hasFinalOutput || !(isLast && streaming));
        const thoughtId = block.id || `think_${start}`;
        const thoughtExpanded = isThoughtExpanded(thoughtId);
        nodes.push(
          <ThoughtStep
            key={thoughtId}
            content={parts.join('\n\n')}
            isGenerating={isGenerating}
            showDone={showDone}
            expanded={thoughtExpanded}
            onToggle={() => toggleExpand(thoughtId, !thoughtExpanded)}
          />,
        );
        continue;
      }

      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const tool = block.tool;
        const isCommand = block.type === 'command';
        const isSubagentCall = !isCommand && isSubagentToolName(tool.name);

        // Coalesce consecutive subagent launches into one Cursor-style checklist.
        if (isSubagentCall) {
          const batch: DisplayBlock[] = [];
          while (
            ti < blocks.length &&
            (blocks[ti].type === 'toolCall' || blocks[ti].type === 'command') &&
            blocks[ti].tool &&
            blocks[ti].type !== 'command' &&
            isSubagentToolName(blocks[ti].tool!.name)
          ) {
            batch.push(blocks[ti]);
            ti++;
          }
          const agents = resolveChecklistAgents(batch, subagentBlocks);
          const batchKey = batch
            .map((b) => b.tool?.id || b.id)
            .filter(Boolean)
            .join('-');
          nodes.push(
            <SubagentLaunchList
              key={`subagents-${batchKey || ti}`}
              agents={agents}
              subBlocks={subagentBlocks}
              subPrompts={subagentPrompts}
              modelLabel={modelLabel}
            />,
          );
          continue;
        }

        const toolId = tool.id || block.id || `tool_${ti}`;
        const promptEntries =
          tool.id && subagentPrompts
            ? Array.from(subagentPrompts.entries())
                .filter(([k]) => k === tool.id)
                .map(([, v]) => v)
            : [];
        const agentId =
          promptEntries[0]?.subagentId ??
          extractAgentId(tool.context) ??
          undefined;
        const filename = !isCommand ? extractFilename(tool.context) : null;
        const label = getToolLabel(tool.name, {
          agentId: agentId ?? undefined,
          filename: filename ?? undefined,
          command: isCommand ? extractCommand(tool.context) ?? undefined : undefined,
          status: tool.status,
        });
        const expanded = isToolExpanded(toolId, tool.status, tool.name);

        nodes.push(
          <ToolStepRow
            key={toolId}
            tool={tool}
            label={label}
            isCommand={isCommand}
            expanded={expanded}
            onToggle={() => toggleExpand(toolId, !expanded)}
            afterRow={
              promptEntries.length > 0 ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  {promptEntries.map((p, pi) => (
                    <PromptDisclosure
                      key={`${toolId}-prompt-${pi}`}
                      content={p.content}
                      tokens={p.tokens}
                      label={
                        p.subagentId
                          ? `SUB-AGENT PROMPT · ${p.subagentId}`
                          : 'SUB-AGENT PROMPT'
                      }
                    />
                  ))}
                </div>
              ) : null
            }
          >
            <ToolCallItemBody
              tool={tool}
              progress={tool.id ? toolProgress?.get(tool.id) : undefined}
            />
          </ToolStepRow>,
        );
        ti++;
        continue;
      }

      if (block.type === 'recalledMemories' && block.memories && block.memories.length > 0) {
        const recallId = block.id || `recall_${ti}`;
        const recallExpanded = isToolExpanded(recallId, 'done');
        nodes.push(
          <RecalledMemoryStep
            key={recallId}
            memories={block.memories}
            expanded={recallExpanded}
            onToggle={() => toggleExpand(recallId, !recallExpanded)}
          />,
        );
        ti++;
        continue;
      }

      // Non-process leftovers inside process list (ignore)
      ti++;
    }
    return nodes;
  };

  const renderFinal = (blocks: DisplayBlock[]) =>
    blocks.map((block, index) => {
      if (!block.content) return null;
      const key = block.id || `final_${index}`;
      const isFinalStreaming = !!(isLast && streaming);
      return (
        <div
          key={key}
          className={cn(
            'chat-streaming-block',
            isFinalStreaming && 'chat-streaming-block--live',
          )}
        >
          <div
            className={cn(
              'chat-message-text text-foreground/90 space-y-3 max-w-none',
              isFinalStreaming && 'streaming-markdown-content',
            )}
          >
            <Markdown
              content={block.content}
              variant="assistant"
              live={isFinalStreaming}
            />
          </div>
        </div>
      );
    });

  return (
    <div className="process-timeline" data-slot="process-timeline">
      {(processBlocks.length > 0 || showPendingThinking) && (
        <ActivitySummary
          thoughtCount={coalescedThoughtCount || (showPendingThinking ? 1 : 0)}
          toolsCount={toolsCount}
          viewedCount={viewedCount}
          editedCount={editedCount}
          ranCount={ranCount}
          usedCount={usedCount}
          summary={processSummary}
          live={livePacked}
          liveDetail={liveDetail || null}
          defaultOpen={livePacked && !hasFinalOutput}
          collapseWhen={hasFinalOutput}
        >
          {showPendingThinking && (
            <ThoughtStep
              content=""
              isGenerating
              expanded={isThoughtExpanded('pending_think')}
              onToggle={() =>
                toggleExpand(
                  'pending_think',
                  !isThoughtExpanded('pending_think'),
                )
              }
            />
          )}
          {renderProcessBlocks(processBlocks)}
        </ActivitySummary>
      )}
      {checkpointBlocks.length > 0 && (
        <div className="flex flex-col items-start gap-1">
          {checkpointBlocks.map((block) => (
            <SavePointChip
              key={block.id}
              workbenchSessionId={wbSessionId}
              checkpointId={block.checkpoint?.id}
              label={block.checkpoint?.label}
              fileCount={block.checkpoint?.fileCount}
            />
          ))}
        </div>
      )}
      {hasFinalOutput && renderFinal(finalBlocks)}
    </div>
  );
}
