import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  ToolCallItemBody,
  extractAgentId,
} from '@/components/chat/ToolCallItem';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { ThoughtStep } from '@/components/chat/ThoughtStep';
import { ToolStepRow } from '@/components/chat/ToolStepRow';
import { SubagentLaunchList } from '@/components/chat/SubagentLaunchList';
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
import {
  addRightDrawerSection,
  clearActivityAutoOpenSuppression,
  closeRightDrawerSection,
} from '@/components/shell/RightDrawerState';
import { getToolLabel } from '@/lib/tool-labels';
import { modelDisplayParts } from '../model-display';
import { resolveUiSessionId } from '../stream/session-id-map';

type DisplayBlock = MessageBlock;

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

/** Interleaved Claude-style process timeline + final answer. */
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

  // Id-keyed expand overrides; missing key → default from tool status.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>(
    {},
  );

  const toggleTool = (id: string, next: boolean) => {
    setExpandOverrides((prev) => ({ ...prev, [id]: next }));
  };

  const isToolExpanded = (toolId: string, status: string | undefined) => {
    if (toolId in expandOverrides) return expandOverrides[toolId];
    return status === 'running';
  };

  const thinkingParts = processBlocks
    .filter((b) => b.type === 'thinking' && b.content?.trim())
    .map((b) => b.content!.trim());
  const processSummary = buildProcessSummaryLine(thinkingParts);

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
        });
        const detail =
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
                  : label;
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
        closeRightDrawerSection('activity', { fromAuto: true });
        clearActivityAutoOpenSuppression();
      }
      return;
    }
    publishLiveActivity({
      sessionId: liveSessionKey,
      headline: liveDetail || processSummary || 'Working…',
      items: liveItems,
    });
    addRightDrawerSection('activity', { fromAuto: true });
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
        nodes.push(
          <ThoughtStep
            key={block.id || `think_${start}`}
            content={parts.join('\n\n')}
            isGenerating={isGenerating}
          />,
        );
        continue;
      }

      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const tool = block.tool;
        const toolId = tool.id || block.id || `tool_${ti}`;
        const isCommand = block.type === 'command';
        const isSubagentCall = isSubagentToolName(tool.name);
        const promptEntries =
          isSubagentCall && tool.id && subagentPrompts
            ? Array.from(subagentPrompts.entries())
                .filter(([k]) => k === tool.id)
                .map(([, v]) => v)
            : [];
        const agentId =
          promptEntries[0]?.subagentId ??
          extractAgentId(tool.context) ??
          undefined;
        const label = getToolLabel(tool.name, {
          agentId: agentId ?? undefined,
          status: tool.status,
        });
        const expanded = isToolExpanded(toolId, tool.status);
        const subagentContainers =
          tool.id && subagentBlocks
            ? Array.from(subagentBlocks.values())
                .filter((s) => s.parentToolId === tool.id)
                .sort((a, b) => a.startedAt - b.startedAt)
            : [];

        nodes.push(
          <ToolStepRow
            key={toolId}
            tool={tool}
            label={label}
            isCommand={isCommand}
            expanded={expanded}
            onToggle={() => toggleTool(toolId, !expanded)}
            afterRow={
              isSubagentCall &&
              (promptEntries.length > 0 || subagentContainers.length > 0) ? (
                <>
                  {promptEntries.length > 0 && (
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
                  )}
                  {subagentContainers.length > 0 && (
                    <SubagentLaunchList
                      agents={subagentContainers}
                      subBlocks={subagentBlocks}
                      subPrompts={subagentPrompts}
                      modelLabel={modelLabel}
                    />
                  )}
                </>
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
        <div key={key} className="chat-streaming-block">
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
      {showPendingThinking && <ThoughtStep content="" isGenerating />}
      {renderProcessBlocks(processBlocks)}
      {hasFinalOutput && renderFinal(finalBlocks)}
    </div>
  );
}
