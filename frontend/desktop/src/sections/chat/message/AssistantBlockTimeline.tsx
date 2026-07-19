import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  ToolCallItemBody,
  extractAgentId,
} from '@/components/chat/ToolCallItem';
import { ToolSummary, buildToolSummaryEntry } from '@/components/chat/ToolSummary';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { classifyTool } from '@/lib/tool-classify';
import { SubagentLaunchList } from '@/components/chat/SubagentLaunchList';
import { isSubagentToolName } from '@/components/chat/subagent-tools';
import { Markdown } from '../ChatMarkdown';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { SubagentBlockState } from '../chat-stream-manager';
import { ReasoningBlock } from './ReasoningBlock';
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

type DisplayBlock = MessageBlock;

type ToolEntry = DisplayBlock & { tool: NonNullable<DisplayBlock['tool']> };
type ThinkingEntry = { block: DisplayBlock; index: number };
type RenderUnit =
  | { kind: 'single'; block: DisplayBlock; index: number }
  | { kind: 'tool_group'; entries: Array<{ block: ToolEntry; index: number }> }
  | { kind: 'thinking_group'; entries: ThinkingEntry[] };

function isFinalOutputUnit(unit: RenderUnit): boolean {
  return (
    unit.kind === 'single' &&
    unit.block.type === 'finalOutput' &&
    !!(unit.block.content && String(unit.block.content).trim())
  );
}

/** Split timeline into process (thinking/tools) vs final answer units. */
function splitActivityAndFinal(units: RenderUnit[]): {
  activityUnits: RenderUnit[];
  finalUnits: RenderUnit[];
  hasFinalOutput: boolean;
} {
  const activityUnits: RenderUnit[] = [];
  const finalCandidates: RenderUnit[] = [];
  for (const unit of units) {
    if (isFinalOutputUnit(unit)) finalCandidates.push(unit);
    else activityUnits.push(unit);
  }
  // Only the last finalOutput is the answer. Earlier segments were provisional
  // (think → draft text → think again) and belong in the activity pack.
  const finalUnits =
    finalCandidates.length > 0 ? [finalCandidates[finalCandidates.length - 1]] : [];
  if (finalCandidates.length > 1) {
    activityUnits.push(...finalCandidates.slice(0, -1));
  }
  return {
    activityUnits,
    finalUnits,
    hasFinalOutput: finalUnits.length > 0,
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

/** Groups consecutive thinking / toolCall blocks and renders the assistant timeline. */
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
  const liveSessionKey = routeSessionId || message.id;
  const modelLabel = modelId ? modelDisplayParts(modelId).name : undefined;

  // Pre-process blocks:
  //  - consecutive toolCall/command → tool_group (one ToolSummary)
  //  - consecutive thinking → thinking_group (one "Thinking (N)" disclosure)
  // After final output exists, ALL pre-final activity collapses into
  // one ActivitySummary (Thought N · Tools N · …); expand shows the
  // normal timeline of thoughts + tools.
  const units: RenderUnit[] = [];
  let i = 0;
  while (i < displayBlocks.length) {
    const block = displayBlocks[i];
    if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
      const entries: Array<{ block: ToolEntry; index: number }> = [];
      while (
        i < displayBlocks.length &&
        (displayBlocks[i].type === 'toolCall' || displayBlocks[i].type === 'command') &&
        displayBlocks[i].tool
      ) {
        entries.push({ block: displayBlocks[i] as ToolEntry, index: i });
        i++;
      }
      units.push({ kind: 'tool_group', entries });
    } else if (block.type === 'thinking') {
      const entries: ThinkingEntry[] = [];
      while (i < displayBlocks.length && displayBlocks[i].type === 'thinking') {
        entries.push({ block: displayBlocks[i], index: i });
        i++;
      }
      units.push({ kind: 'thinking_group', entries });
    } else {
      units.push({ kind: 'single', block, index: i });
      i++;
    }
  }

  // Pack ALL thinking/tools into the summary — not only units before the
  // first final block (interleaved think→answer→think used to leak process).
  const { activityUnits, finalUnits: afterUnits, hasFinalOutput } =
    splitActivityAndFinal(units);

  // Aggregate counts across the whole pre-final activity for the
  // single collapsed header.
  let totalThoughts = 0;
  let totalViewed = 0;
  let totalEdited = 0;
  let totalRan = 0;
  let totalUsed = 0;
  let totalTools = 0;
  const thinkingParts: string[] = [];
  for (const u of activityUnits) {
    if (u.kind === 'thinking_group') {
      totalThoughts += u.entries.length;
      for (const e of u.entries) {
        if (e.block.content?.trim()) thinkingParts.push(e.block.content);
      }
    } else if (u.kind === 'single' && u.block.type === 'thinking') {
      totalThoughts += 1;
      if (u.block.content?.trim()) thinkingParts.push(u.block.content);
    } else if (u.kind === 'tool_group') {
      for (const { block } of u.entries) {
        totalTools++;
        const bucket = classifyTool(block.tool.name);
        if (bucket === 'view') totalViewed++;
        else if (bucket === 'edit') totalEdited++;
        else if (bucket === 'run') totalRan++;
        else totalUsed++;
      }
    }
  }
  const processSummary = buildProcessSummaryLine(thinkingParts);
  const durationLabel =
    typeof message.thinkingDuration === 'number' && message.thinkingDuration > 0
      ? `Thought for ${
          message.thinkingDuration >= 10
            ? `${Math.round(message.thinkingDuration)}s`
            : `${message.thinkingDuration.toFixed(1)}s`
        }`
      : null;

  const packActivity =
    activityUnits.length > 0 &&
    (hasFinalOutput || !(isLast && streaming));
  const livePacked = !!(packActivity && isLast && streaming);

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
        // Keep the latest step marked running while the turn streams.
        items[items.length - 1] = { ...last, status: last.status === 'error' ? 'error' : 'running' };
      }
    }
    return { liveDetail, liveItems: items };
  }, [displayBlocks, showPendingThinking, isLast, streaming]);

  useEffect(() => {
    if (!livePacked) {
      if (isLast && !streaming) {
        clearLiveActivity(liveSessionKey);
        // Drop empty Activity so the Workbench doesn't stay open with no data.
        // fromAuto: don't treat this as a user dismiss — next turn can auto-open.
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
    // Respect user dismiss — keep publishing live data without forcing the drawer.
    addRightDrawerSection('activity', { fromAuto: true });
  }, [livePacked, liveSessionKey, liveDetail, liveItems, processSummary, isLast, streaming]);

  const renderThinkingGroup = (
    unit: Extract<RenderUnit, { kind: 'thinking_group' }>,
    unitIdx: number,
    unitList: RenderUnit[],
    opts?: { forceIdle?: boolean },
  ) => {
    const lastIndex = unit.entries[unit.entries.length - 1]?.index ?? 0;
    const isGenerating =
      !opts?.forceIdle &&
      !!(isLast && streaming && lastIndex === displayBlocks.length - 1);
    const n = unit.entries.length;
    const segments = unit.entries.map((e) => e.block.content || '');
    const isTrailingThought = !unitList
      .slice(unitIdx + 1)
      .some((u) => u.kind === 'thinking_group');

    return (
      <div
        key={`thinking_group_${unit.entries[0]?.index ?? 0}`}
        className="chat-streaming-block"
      >
        <ReasoningBlock
          segments={segments}
          isGenerating={isGenerating}
          duration={
            !isGenerating && isTrailingThought
              ? message.thinkingDuration
              : undefined
          }
          thoughtCount={n}
        />
      </div>
    );
  };

  const renderToolGroup = (
    unit: Extract<RenderUnit, { kind: 'tool_group' }>,
    unitIdx: number,
    unitList: RenderUnit[],
    opts?: { forceIdle?: boolean },
  ) => {
    let thoughtCount = 0;
    {
      const prev = unitIdx > 0 ? unitList[unitIdx - 1] : null;
      if (prev?.kind === 'thinking_group') {
        thoughtCount = prev.entries.length;
      }
    }

    let viewedCount = 0;
    let editedCount = 0;
    let ranCount = 0;
    let usedCount = 0;

    const summaryEntries = unit.entries
      .map(({ block, index }) => {
        const isSubagentCall = isSubagentToolName(block.tool.name);
        const promptEntries = isSubagentCall && block.tool.id && subagentPrompts
          ? Array.from(subagentPrompts.entries())
              .filter(([k]) => k === block.tool.id)
              .map(([, v]) => v)
          : [];
        const agentId =
          promptEntries[0]?.subagentId ??
          extractAgentId(block.tool.context) ??
          undefined;

        const bucket = classifyTool(block.tool.name);
        if (bucket === 'view') viewedCount++;
        else if (bucket === 'edit') editedCount++;
        else if (bucket === 'run') ranCount++;
        else usedCount++;

        const entry = buildToolSummaryEntry(block.tool, { agentIdOverride: agentId });
        if (!entry.id) entry.id = `tool_${index}`;
        return { entry, block, index, promptEntries, isSubagentCall, bucket };
      })
      // No card/container for read/view tools — only edits, commands, and other tools.
      .filter((row) => row.bucket !== 'view');

    if (summaryEntries.length === 0) {
      return null;
    }

    const isLive =
      !opts?.forceIdle &&
      (summaryEntries.some(
        ({ entry }) =>
          entry.status === 'running' || entry.awaitingApproval,
      ) ||
        !!(
          isLast &&
          streaming &&
          unit.entries.some(
            (e) =>
              e.index === displayBlocks.length - 1 ||
              displayBlocks[displayBlocks.length - 1]?.type === 'toolCall' ||
              displayBlocks[displayBlocks.length - 1]?.type === 'command',
          ) &&
          !unitList.slice(unitIdx + 1).some((u) => u.kind === 'tool_group')
        ));

    // Inside the settled activity pack, don't re-badge thoughts
    // on every tool group — the outer ActivitySummary already
    // shows Thought (N). Keep per-group tool buckets only.
    const showThoughtOnTools = !opts?.forceIdle;

    return (
      <div
        key={`tool_group_${unit.entries[0]?.index ?? 0}`}
        className="chat-streaming-block ml-3 pl-3 chat-rail-2 space-y-1.5"
      >
        <ToolSummary
          thoughtCount={showThoughtOnTools ? thoughtCount : 0}
          viewedCount={viewedCount}
          editedCount={editedCount}
          ranCount={ranCount}
          usedCount={usedCount}
          entries={summaryEntries.map((s) => s.entry)}
          isLive={isLive}
          renderToolBody={(tool) => (
            <ToolCallItemBody
              tool={tool}
              progress={tool.id ? toolProgress?.get(tool.id) : undefined}
            />
          )}
          renderAfterRow={(summaryEntry) => {
            const meta = summaryEntries.find((s) => s.entry.id === summaryEntry.id);
            if (!meta) return null;
            const { block, promptEntries, isSubagentCall } = meta;
            if (!isSubagentCall) return null;
            const subagentContainers = block.tool.id && subagentBlocks
              ? Array.from(subagentBlocks.values())
                  .filter((s) => s.parentToolId === block.tool.id)
                  .sort((a, b) => a.startedAt - b.startedAt)
              : [];
            if (promptEntries.length === 0 && subagentContainers.length === 0) {
              return null;
            }
            return (
              <>
                {promptEntries.length > 0 && (
                  <div className="ml-1 mt-1 flex flex-col gap-1">
                    {promptEntries.map((p, pi) => (
                      <PromptDisclosure
                        key={`${block.tool.id}-prompt-${pi}`}
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
                  <SubagentLaunchList
                    agents={subagentContainers}
                    subBlocks={subagentBlocks}
                    subPrompts={subagentPrompts}
                    modelLabel={modelLabel}
                  />
                )}
              </>
            );
          }}
        />
      </div>
    );
  };

  const renderSingle = (
    unit: Extract<RenderUnit, { kind: 'single' }>,
  ) => {
    const block = unit.block;
    const index = unit.index;
    const key = block.id || `${block.type}_${index}`;
    if (block.type === 'thinking') {
      return (
        <div key={key} className="chat-streaming-block">
          <ReasoningBlock
            text={block.content || ''}
            isGenerating={!!(isLast && streaming && index === displayBlocks.length - 1)}
            duration={message.thinkingDuration}
          />
        </div>
      );
    }
    if (block.type === 'finalOutput') {
      if (!block.content) return null;
      const isFinalStreaming = !!(isLast && streaming);
      return (
        <div key={key} className="chat-streaming-block">
          <div className={cn(
            'chat-message-text text-foreground/90 space-y-3 max-w-none',
            isFinalStreaming && 'streaming-markdown-content',
          )}>
            <Markdown content={block.content} variant="assistant" live={isFinalStreaming} />
          </div>
        </div>
      );
    }
    return null;
  };

  const renderUnitList = (
    list: RenderUnit[],
    opts?: { forceIdle?: boolean },
  ) =>
    list.map((unit, unitIdx) => {
      if (unit.kind === 'thinking_group') {
        return renderThinkingGroup(unit, unitIdx, list, opts);
      }
      if (unit.kind === 'tool_group') {
        return renderToolGroup(unit, unitIdx, list, opts);
      }
      return renderSingle(unit);
    });

  return (
    <>
      {showPendingThinking && (
        <div key="pending-thinking" className="chat-streaming-block">
          <ReasoningBlock text="" isGenerating />
        </div>
      )}
      {(() => {
        // Collapse thoughts/tools as soon as a final answer appears (even while
        // still streaming) so the chat stays short. Live status mirrors to the
        // right-side Activity panel so collapse never looks stuck.
        if (packActivity) {
          const hasActivity =
            totalThoughts + totalTools > 0 ||
            !!processSummary ||
            activityUnits.length > 0 ||
            livePacked;
          return (
            <>
              {hasActivity && (
                <div key="activity-pack" className="chat-streaming-block">
                  <ActivitySummary
                    thoughtCount={totalThoughts}
                    toolsCount={totalTools}
                    viewedCount={totalViewed}
                    editedCount={totalEdited}
                    ranCount={totalRan}
                    usedCount={totalUsed}
                    summary={processSummary}
                    durationLabel={
                      processSummary || livePacked ? null : durationLabel
                    }
                    live={livePacked}
                    liveDetail={livePacked ? liveDetail || 'Working…' : null}
                  >
                    {renderUnitList(activityUnits, { forceIdle: true })}
                  </ActivitySummary>
                </div>
              )}
              {renderUnitList(afterUnits)}
            </>
          );
        }

        if (hasFinalOutput) {
          // Live stream with final text: show activity expanded, then final
          // with the same afterUnits path used after settle.
          return (
            <>
              {renderUnitList(activityUnits)}
              {renderUnitList(afterUnits)}
            </>
          );
        }

        // No final yet: stream normal multi-section timeline.
        return renderUnitList(units);
      })()}
    </>
  );
}
