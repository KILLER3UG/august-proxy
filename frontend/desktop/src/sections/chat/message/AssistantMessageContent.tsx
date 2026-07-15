import { Check, RefreshCw, Play, Pause, Bug } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  ToolCallItemBody,
  extractAgentId,
} from '@/components/chat/ToolCallItem';
import { ToolSummary, buildToolSummaryEntry } from '@/components/chat/ToolSummary';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { RecapCard } from '@/components/chat/RecapCard';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { classifyTool } from '@/lib/tool-classify';
import { SubagentBlock } from '@/components/chat/SubagentBlock';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import { Markdown } from '../ChatMarkdown';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import { ReasoningBlock } from './ReasoningBlock';

type DisplayBlock = MessageBlock;

type ToolEntry = DisplayBlock & { tool: NonNullable<DisplayBlock['tool']> };
type ThinkingEntry = { block: DisplayBlock; index: number };
type RenderUnit =
  | { kind: 'single'; block: DisplayBlock; index: number }
  | { kind: 'tool_group'; entries: Array<{ block: ToolEntry; index: number }> }
  | { kind: 'thinking_group'; entries: ThinkingEntry[] };

/** Groups consecutive thinking / toolCall blocks and renders the assistant timeline. */
function AssistantBlockTimeline({
  displayBlocks,
  message,
  isLast,
  streaming,
  showPendingThinking,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
}: {
  displayBlocks: DisplayBlock[];
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  showPendingThinking: boolean;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  subagentPrompts?: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  subagentBlocks?: Map<string, SubagentBlockState>;
}) {
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

  const firstFinalUnitIdx = units.findIndex(
    (u) =>
      u.kind === 'single' &&
      u.block.type === 'finalOutput' &&
      !!(u.block.content && String(u.block.content).trim()),
  );
  const hasFinalOutput = firstFinalUnitIdx >= 0;
  const activityUnits = hasFinalOutput
    ? units.slice(0, firstFinalUnitIdx)
    : units;
  const afterUnits = hasFinalOutput
    ? units.slice(firstFinalUnitIdx)
    : [];

  // Aggregate counts across the whole pre-final activity for the
  // single collapsed header.
  let totalThoughts = 0;
  let totalViewed = 0;
  let totalEdited = 0;
  let totalRan = 0;
  let totalUsed = 0;
  let totalTools = 0;
  for (const u of activityUnits) {
    if (u.kind === 'thinking_group') {
      totalThoughts += u.entries.length;
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
      <motion.div
        key={`thinking_group_${unit.entries[0]?.index ?? 0}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
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
      </motion.div>
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

    const summaryEntries = unit.entries.map(({ block, index }) => {
      const isSubagentCall =
        block.tool.name === 'august__spawn_subagent' ||
        block.tool.name === 'workbench_spawn_subagent' ||
        block.tool.name === 'august__run_team' ||
        block.tool.name === 'workbench_run_team';
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
      return { entry, block, index, promptEntries, isSubagentCall };
    });

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
      <motion.div
        key={`tool_group_${unit.entries[0]?.index ?? 0}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        className="chat-streaming-block ml-3 pl-3 border-l-2 border-foreground/15 space-y-1.5"
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
                  <div className="ml-1 mt-1 flex flex-col gap-1">
                    {subagentContainers.map((s) => (
                      <SubagentBlock
                        key={s.jobId}
                        state={s}
                        subBlocks={subagentBlocks}
                        subPrompts={subagentPrompts}
                      />
                    ))}
                  </div>
                )}
              </>
            );
          }}
        />
      </motion.div>
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
        <motion.div
          key={key}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="chat-streaming-block"
        >
          <ReasoningBlock
            text={block.content || ''}
            isGenerating={!!(isLast && streaming && index === displayBlocks.length - 1)}
            duration={message.thinkingDuration}
          />
        </motion.div>
      );
    }
    if (block.type === 'finalOutput') {
      if (!block.content) return null;
      const isFinalStreaming = !!(isLast && streaming);
      return (
        <motion.div
          key={key}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="chat-streaming-block"
        >
          <div className={cn(
            'chat-message-text text-foreground/90 space-y-3 max-w-none',
            isFinalStreaming && 'streaming-markdown-content',
          )}>
            <Markdown content={block.content} />
          </div>
        </motion.div>
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
    <AnimatePresence initial={false}>
      {showPendingThinking && (
        <motion.div
          key="pending-thinking"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="chat-streaming-block"
        >
          <ReasoningBlock text="" isGenerating />
        </motion.div>
      )}
      {(() => {
        // Settled turn with final answer: one ActivitySummary for all
        // prior work, then the final prose outside.
        if (hasFinalOutput) {
          const hasActivity =
            totalThoughts + totalTools > 0 ||
            activityUnits.some((u) => u.kind !== 'single');
          return (
            <>
              {hasActivity && (
                <motion.div
                  key="activity-pack"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className="chat-streaming-block"
                >
                  <ActivitySummary
                    thoughtCount={totalThoughts}
                    toolsCount={totalTools}
                    viewedCount={totalViewed}
                    editedCount={totalEdited}
                    ranCount={totalRan}
                    usedCount={totalUsed}
                  >
                    {renderUnitList(activityUnits, { forceIdle: true })}
                  </ActivitySummary>
                </motion.div>
              )}
              {renderUnitList(afterUnits)}
            </>
          );
        }

        // Live / no final yet: stream normal multi-section timeline.
        return renderUnitList(units);
      })()}
    </AnimatePresence>
  );
}

/** Assistant message body: blocks timeline, recap, and action footer. */
export function AssistantMessageContent({
  message,
  isLast,
  streaming,
  modelId,
  displayBlocks,
  showPendingThinking,
  showRaw,
  setShowRaw,
  showActions,
  copied,
  speaking,
  isRegenerating,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  onSpeak,
  onCopy,
  onRegen,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  modelId?: string | null;
  displayBlocks: DisplayBlock[];
  showPendingThinking: boolean;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isRegenerating: boolean;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  subagentPrompts?: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
}) {
  return (
    <>
      <div className="flex flex-col w-full gap-2">
        {showRaw ? (
          <div className="p-3 bg-muted/40 rounded-xl border border-border/50 text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto leading-relaxed">
            {JSON.stringify(message, null, 2)}
          </div>
        ) : (
          <AssistantBlockTimeline
            displayBlocks={displayBlocks}
            message={message}
            isLast={isLast}
            streaming={streaming}
            showPendingThinking={showPendingThinking}
            toolProgress={toolProgress}
            subagentPrompts={subagentPrompts}
            subagentBlocks={subagentBlocks}
          />
        )}
        {(() => {
          const cf = message.changedFiles as { files?: unknown[] } | undefined;
          return cf && Array.isArray(cf.files) && cf.files.length > 0
            ? <ChangedFilesCard changes={message.changedFiles as GitDiffResult} />
            : null;
        })()}
        {/* End-of-turn recap: instant template from tools/files; AI rewrite optional.
            Hide while this message is still streaming so it appears with the settled answer. */}
        {!(isLast && streaming) && (
          <RecapCard
            modelId={modelId}
            input={{
              blocks: message.blocks,
              tools: message.tools,
              changedFiles: message.changedFiles as {
                files?: Array<{ path: string; added?: number; removed?: number; status?: string }>;
              } | undefined,
              finalText:
                message.blocks
                  ?.filter((b) => b.type === 'finalOutput' && b.content)
                  .map((b) => b.content || '')
                  .join('\n') ||
                message.content ||
                '',
            }}
          />
        )}
      </div>
      {/* Action buttons below assistant message */}
      <div className={cn(
        "flex items-center gap-0.5 mt-1 transition-opacity duration-150 self-start",
        showActions ? "opacity-100" : "opacity-0"
      )}>
        <button
          onClick={onSpeak}
          className={cn(
            "p-1 rounded transition",
            speaking
              ? "bg-primary/10 text-primary hover:bg-primary/20"
              : "hover:bg-muted text-muted-foreground hover:text-foreground"
          )}
          title={speaking ? "Pause reading" : "Read aloud"}
        >
          {speaking ? (
            <Pause className="size-3" />
          ) : (
            <Play className="size-3" />
          )}
        </button>
        <button
          onClick={onCopy}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition relative"
          title="Copy"
        >
          <div className={cn("transition-transform duration-200", copied ? "scale-110 text-success" : "scale-100")}>
            {copied ? (
              <Check className="size-3" />
            ) : (
              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            )}
          </div>
        </button>
        {isLast && (
          <button
            onClick={onRegen}
            disabled={streaming || isRegenerating}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
            title="Retry / Regenerate"
          >
            <RefreshCw
              className={cn("size-3", isRegenerating && "animate-spin")}
            />
          </button>
        )}
        <button
          onClick={() => setShowRaw(!showRaw)}
          className={cn("p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition", showRaw && "text-primary")}
          title="Toggle raw data"
        >
          <Bug className="size-3" />
        </button>
      </div>
    </>
  );
}
