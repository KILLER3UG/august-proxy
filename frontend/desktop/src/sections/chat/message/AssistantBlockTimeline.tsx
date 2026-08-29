import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ToolCallItemBody,
  extractAgentId,
  extractCommand,
  extractDiffData,
  extractFilename,
} from '@/components/chat/ToolCallItem';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { ThoughtStep } from '@/components/chat/ThoughtStep';
import { isCollapseThinkingEnabled } from '@/lib/thinking-preference';
import { ToolStepRow } from '@/components/chat/ToolStepRow';
import { EditRailRow } from '@/components/chat/EditRailRow';
import { MemoryEditRow } from '@/components/chat/MemoryEditRow';
import { RailDoneRow } from '@/components/chat/RailDoneRow';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { SearchResultsTask } from '@/components/chat/SearchResultsCard';
import { isSubagentToolName } from '@/components/chat/subagent-tools';
import { classifyTool, normalizeToolName } from '@/lib/tool-classify';
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
import { useVerboseMode } from '@/lib/verbose-mode';
import { resolveUiSessionId, resolveWorkbenchSessionId } from '../stream/session-id-map';
import { api } from '@/api/client';

type DisplayBlock = MessageBlock;

/** Completed thinking sentences kept in the live feed per thinking block —
 *  the working indicator shows the last 3 lines, so older ones are ballast. */
const MAX_LIVE_THINKING_SENTENCES = 6;

/** Split running thinking text into sentence-ish parts (period + whitespace
 *  or paragraph breaks). The final part is the still-in-flight tail. */
function splitThinkingSentences(content: string): string[] {
  return content
    .split(/\.\s+|\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isFinalOutput(block: DisplayBlock): boolean {
  return (
    block.type === 'finalOutput' &&
    !!(block.content && String(block.content).trim())
  );
}

/** Pull the search query out of a web_search tool's JSON args. */
function extractSearchQuery(context?: string): string {
  if (!context) return 'Search';
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    for (const key of ['query', 'q', 'searchQuery', 'search_query', 'search_terms']) {
      const v = parsed?.[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' && v[0].trim()) {
        return v[0].trim();
      }
    }
  } catch {
    /* not JSON */
  }
  return 'Search';
}

/** "6s" / "1m 06s" — total elapsed for a tool-execution sequence. */
function formatSequenceDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
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

/** Plan §4.1 plan-tree group: one `update_state` phase and the tool rows
 *  that ran under it. Finished subtrees auto-collapse (expanded defaults
 *  come from the parent); the active group stays open and highlighted. */
function PlanPhaseGroup({
  phase,
  step,
  active,
  expanded,
  onToggle,
  children,
}: {
  phase: string;
  step?: number;
  active: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('plan-phase-group my-0.5', active && 'plan-phase-group--active')}
      data-slot="plan-phase-group"
      data-active={active ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => onToggle(!expanded)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-xs px-1 py-0.5 text-left text-[12px] font-medium text-foreground/75 hover:bg-accent hover:text-foreground"
        data-testid="plan-phase-head"
      >
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform',
            !expanded && '-rotate-90',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate" title={phase}>
          {phase}
          {typeof step === 'number' ? (
            <span className="ml-1 font-normal text-muted-foreground/70">
              · step {step}
            </span>
          ) : null}
        </span>
        {active ? (
          <span className="shrink-0 text-[10px] italic text-muted-foreground/70">
            working…
          </span>
        ) : null}
      </button>
      {expanded ? <div className="plan-phase-body pl-4">{children}</div> : null}
    </div>
  );
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
  sessionId,
  onRetryTurn,
  onSwitchModel,
}: {
  displayBlocks: DisplayBlock[];
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  showPendingThinking: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  /** Keyed by sub-agent jobId; rendered inline via SubagentLaunchList
   *  (and in the persistent right-drawer roster). */
  subagentBlocks?: Map<string, SubagentBlockState>;
  /** Parent session model id — shown as muted tag on subagent launch rows. */
  modelId?: string | null;
  /** Chat session id — keys the per-session /verbose flag (plan §4.2). */
  sessionId?: string | null;
  /** Rendered on error blocks: re-run the turn from the last user prompt. */
  onRetryTurn?: () => void;
  /** Rendered on error blocks: open the "answer with another model" picker. */
  onSwitchModel?: () => void;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const liveSessionKey = resolveUiSessionId(routeSessionId || message.id);
  // /verbose (plan §4.2 item 4): raw tool output renders inline for this
  // session until turned off. Rendering policy only — data layer unchanged.
  const verbose = useVerboseMode(sessionId);
  // Kept in the public props for message-pane compatibility; subagent
  // progress no longer renders an inline model label.
  void modelId;

  const { processBlocks, finalBlocks, hasFinalOutput } =
    splitProcessAndFinal(displayBlocks);

  // Id-keyed expand overrides; missing key → default from status.
  // Tools: running → open, else collapsed. Thoughts: collapsed+clamped by
  // default; the user's explicit expand/collapse WINS until the final
  // answer starts streaming (2026-08-25 fix: mid-turn streaming gaps must
  // NOT wipe manual expansion — only a real final response closes it).
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>(
    {},
  );

  // When the FINAL ANSWER starts generating, drop expand overrides so
  // thoughts re-collapse (user requirement: thinking closes ONLY when the
  // user closes it manually, or when the final response is generating).
  // Partial-final turns (streaming flag flickers between tool rounds) do
  // not reset anything — only a genuine final output block does.
  useEffect(() => {
    if (hasFinalOutput) {
      setExpandOverrides({});
    }
  }, [hasFinalOutput]);

  const toggleExpand = (id: string, next: boolean) => {
    setExpandOverrides((prev) => ({ ...prev, [id]: next }));
  };

  const isToolExpanded = (
    toolId: string,
    status: string | undefined,
    tool?: MessageBlock['tool'],
  ) => {
    if (toolId in expandOverrides) return expandOverrides[toolId];
    // Open while running; once complete the block keeps whatever state the
    // user left it in (ToolStepRow never force-collapses on completion).
    if (status === 'running') return true;
    // Plan §4.1: edit diffs, search hits, and memory writes are
    // expanded-by-default rows (capped bodies, still collapsible).
    if (tool) {
      const bucket = classifyTool(tool.name);
      if (bucket === 'edit' && extractDiffData(tool)) return true;
      if (tool.searchHits && tool.searchHits.length > 0) return true;
      if (bucket === 'memoryWrite') return true;
    }
    return false;
  };

  const isThoughtExpanded = (thoughtId: string) => {
    if (thoughtId in expandOverrides) return expandOverrides[thoughtId];
    // Default to clamped ("Show more") whether streaming or settled — a long
    // thought clamps once it passes the threshold instead of pushing the whole
    // layout. Only an explicit Show more expands it.
    return false;
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
  let searchesCount = 0;
  let commandsCount = 0;
  let errorsCount = 0;
  let memoriesCount = 0;
  let anyToolRunning = false;
  const filesTouched = new Set<string>();
  let seqStart = Number.POSITIVE_INFINITY;
  let seqEnd = 0;
  for (const block of processBlocks) {
    if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
      const tool = block.tool;
      toolsCount += 1;
      const bucket = classifyTool(tool.name);
      if (bucket === 'view') viewedCount += 1;
      else if (bucket === 'edit') editedCount += 1;
      else if (bucket === 'run') ranCount += 1;
      else usedCount += 1;
      // §9 completion tally — files touched, searches run, commands executed.
      if (bucket === 'view' || bucket === 'edit') {
        const path = extractFilename(tool.context);
        if (path) filesTouched.add(path.toLowerCase());
      }
      if (
        (tool.searchHits && tool.searchHits.length > 0) ||
        normalizeToolName(tool.name).includes('web_search')
      ) {
        searchesCount += 1;
      }
      if (block.type === 'command' || bucket === 'run') commandsCount += 1;
      if (tool.status === 'error') errorsCount += 1;
      if (tool.status === 'running') anyToolRunning = true;
      if (tool.startedAt) {
        seqStart = Math.min(seqStart, tool.startedAt);
        seqEnd = Math.max(seqEnd, tool.startedAt + (tool.duration ?? 0));
      }
    }
    if (block.type === 'recalledMemories' && block.memories) {
      // Part 17 A.4: recall rows count as turn activity — keeps the pack
      // mounted for a recall-only turn (no tools, no thinking).
      memoriesCount += block.memories.length;
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!livePacked) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [livePacked]);
  const sequenceDurationLabel =
    Number.isFinite(seqStart) && (anyToolRunning || seqEnd > seqStart)
      ? formatSequenceDuration(
          (anyToolRunning ? nowMs : seqEnd) - seqStart,
        )
      : null;

  const { liveDetail, liveItems } = useMemo(() => {
    const items: LiveActivityItem[] = [];
    let liveDetail = '';
    for (const block of displayBlocks) {
      if (block.type === 'thinking' && block.content?.trim()) {
        // One item per completed sentence so the working indicator advances
        // with the thought instead of pinning the same first-80-char snippet
        // for the whole turn; the in-flight tail rides as the newest item.
        const parts = splitThinkingSentences(block.content.trim());
        const lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
        const lastIsComplete = /[.!?]$/.test(lastPart);
        const completed = (
          lastIsComplete ? parts : parts.slice(0, -1)
        ).slice(-MAX_LIVE_THINKING_SENTENCES);
        const tail = lastIsComplete ? '' : lastPart;
        const blockKey = block.id || `think_${items.length}`;
        for (let si = 0; si < completed.length; si++) {
          items.push({
            id: `${blockKey}_s${si}`,
            kind: 'thinking',
            label: 'Thinking',
            detail: completed[si].slice(0, 120),
            status: 'done',
            at: Date.now(),
          });
        }
        if (tail) {
          items.push({
            id: `${blockKey}_tail`,
            kind: 'thinking',
            label: 'Thinking',
            detail: tail.slice(0, 120),
            status: isLast && streaming ? 'running' : 'done',
            at: Date.now(),
          });
        }
        const newest = tail || completed[completed.length - 1] || '';
        if (newest) {
          const cleanNewest = newest.replace(/^Thinking(?:\.{1,3}|:|\s*·|\s+)/i, '').trim();
          const snippet = (cleanNewest || newest).slice(0, 80);
          liveDetail = `${snippet}${(cleanNewest || newest).length > 80 ? '…' : ''}`;
        }
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

  const renderFlatProcess = (
    blocks: DisplayBlock[],
    withDoneMarker = true,
    keyPrefix = 'flat',
  ) => {
    // Each rendered node is tagged rail (threaded onto the left line:
    // thinking, file edits, the terminal Done marker) or block (everything
    // else). Consecutive rail nodes are grouped into one segment so the line
    // runs continuously through them; block rows sit between segments.
    type Tagged = { kind: 'rail' | 'block'; node: ReactNode };
    const tagged: Tagged[] = [];
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
        const thoughtId = block.id || `think_${start}`;
        // Clamped ("Show more") by default — even while generating. A thought
        // renders in full only when the user explicitly expands it (override),
        // so long reasoning never pushes the whole thread open mid-stream, and
        // a finished thought stays clamped rather than lingering on "Show less".
        const thoughtExpanded =
          thoughtId in expandOverrides ? expandOverrides[thoughtId] : false;
        tagged.push({
          kind: 'rail',
          node: (
            <ThoughtStep
              key={thoughtId}
              content={parts.join('\n\n')}
              isGenerating={isGenerating}
              showFull={thoughtExpanded}
              onToggle={() => toggleExpand(thoughtId, !thoughtExpanded)}
              collapsedDefault={isCollapseThinkingEnabled()}
            />
          ),
        });
        continue;
      }

      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const tool = block.tool;
        const isCommand = block.type === 'command';
        const isSubagentCall = !isCommand && isSubagentToolName(tool.name);

        // Subagent launches are **drawer-only** (simplicity pass):
        // the thread header + right-drawer badge are the single source of
        // truth; no inline pill in the transcript keeps the chat clean.
        // Consume the tool-call blocks silently so they never render inline.
        if (isSubagentCall) {
          while (
            ti < blocks.length &&
            (blocks[ti].type === 'toolCall' || blocks[ti].type === 'command') &&
            blocks[ti].tool &&
            blocks[ti].type !== 'command' &&
            isSubagentToolName(blocks[ti].tool!.name)
          ) {
            ti++;
          }
          continue;
        }

        // update_state bookkeeping is represented by the phase marker
        // itself (plan §4.1 plan tree) — a duplicate "Edited state" rail
        // row is exactly the noise the minimal transcript removes.
        // Failures still render so the user sees them.
        if (
          !isCommand &&
          normalizeToolName(tool.name) === 'update_state' &&
          tool.status !== 'error'
        ) {
          ti++;
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
        const expanded = isToolExpanded(toolId, tool.status, tool);

        // Web-search results render as their own specialized Task block
        // (query trigger + scroll-capped hit list) instead of a generic row.
        if (!isCommand && tool.searchHits && tool.searchHits.length > 0) {
          tagged.push({
            kind: 'block',
            node: (
              <SearchResultsTask
                key={toolId}
                query={extractSearchQuery(tool.context)}
                hits={tool.searchHits}
                expanded={expanded}
                onToggle={(next) => toggleExpand(toolId, next)}
              />
            ),
          });
          ti++;
          continue;
        }

        // File edits render as compact rail rows (pencil · description ·
        // filename chip · ±N), threaded onto the same line as the thinking
        // and the terminal Done marker.
        if (!isCommand && classifyTool(tool.name) === 'edit') {
          tagged.push({
            kind: 'rail',
            node: <EditRailRow key={toolId} tool={tool} expanded={expanded} />,
          });
          ti++;
          continue;
        }

        // Memory writes render as rail rows (brain glyph · entry title),
        // expanded by default to show the saved entry text (plan §4.1).
        if (!isCommand && classifyTool(tool.name) === 'memoryWrite') {
          tagged.push({
            kind: 'rail',
            node: <MemoryEditRow key={toolId} tool={tool} expanded={expanded} />,
          });
          ti++;
          continue;
        }

        const label = getToolLabel(tool.name, {
          agentId: agentId ?? undefined,
          filename: filename ?? undefined,
          command: isCommand ? extractCommand(tool.context) ?? undefined : undefined,
          status: tool.status,
        });

        // Consecutive reads of the same file collapse into one row:
        // `read consolidation.py ×4` (plan §4.1). Errored reads stay
        // individual so the failure stays visible.
        if (
          !isCommand &&
          classifyTool(tool.name) === 'view' &&
          tool.status !== 'error' &&
          filename
        ) {
          let count = 1;
          let totalDuration = typeof tool.duration === 'number' ? tool.duration : 0;
          let tj = ti + 1;
          while (tj < blocks.length) {
            const nb = blocks[tj];
            if (nb.type !== 'toolCall' || !nb.tool) break;
            const nt = nb.tool;
            if (nt.status === 'error' || classifyTool(nt.name) !== 'view') break;
            if (extractFilename(nt.context) !== filename) break;
            count += 1;
            if (typeof nt.duration === 'number') totalDuration += nt.duration;
            tj += 1;
          }
          if (count > 1) {
            tagged.push({
              kind: 'block',
              node: (
                <ToolStepRow
                  key={toolId}
                  tool={{ ...tool, duration: totalDuration }}
                  label={`${label} ×${count}`}
                  isCommand={false}
                  expanded={false}
                  verbose={verbose}
                  onToggle={(next) => toggleExpand(toolId, next)}
                >
                  <ToolCallItemBody
                    tool={tool}
                    hideProgress
                    verbose={verbose}
                  />
                </ToolStepRow>
              ),
            });
            ti = tj;
            continue;
          }
        }

        tagged.push({
          kind: 'block',
          node: (
            <ToolStepRow
              key={toolId}
              tool={tool}
              label={label}
              isCommand={isCommand}
              expanded={expanded}
              verbose={verbose}
              onToggle={(next) => toggleExpand(toolId, next)}
              progress={tool.id ? toolProgress?.get(tool.id) : undefined}
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
                hideProgress
                verbose={verbose}
              />
            </ToolStepRow>
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'memoryNotice') {
        // Plan §4.1: a memory write renders as one subtle chip — entry title
        // only, no raw payload in the transcript.
        tagged.push({
          kind: 'block',
          node: (
            <div
              key={block.id || `memory_${ti}`}
              data-testid="memory-notice-chip"
              className="mx-3 my-1 inline-flex max-w-full items-center gap-1.5 rounded-full border border-sky-500/25 bg-sky-500/8 px-2.5 py-1 text-[11px] text-sky-300/90"
              title={block.content || undefined}
            >
              <span aria-hidden="true" className="opacity-70">
                🧠
              </span>
              <span className="truncate">{block.content || 'Memory updated'}</span>
            </div>
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'recalledMemories' && block.memories && block.memories.length > 0) {
        // Part 17 A.4 (gap C-13): what the per-turn <memory> tail actually
        // recalled this turn — one subtle chip; the rows expand on click.
        // Global + project rows both ride here, scope-tagged.
        const rows = block.memories;
        const projectCount = rows.filter((m) => m.scope === 'project').length;
        const label =
          rows.length === 1
            ? `Recalled: ${rows[0].key || rows[0].snippet || 'memory'}`
            : `Recalled ${rows.length} memories${projectCount ? ` (${projectCount} project)` : ''}`;
        tagged.push({
          kind: 'block',
          node: (
            <details
              key={block.id || `recall_${ti}`}
              data-testid="recalled-memories-block"
              className="mx-3 my-1 max-w-full rounded border border-sky-500/20 bg-sky-500/5 px-2.5 py-1 text-[11px] text-sky-300/90"
            >
              <summary className="cursor-pointer select-none list-none">
                <span aria-hidden="true" className="mr-1 opacity-70">
                  💭
                </span>
                <span className="truncate">{label}</span>
              </summary>
              <ul className="mt-1 space-y-1 pl-1">
                {rows.map((m) => (
                  <li key={m.id} className="flex items-start gap-1.5">
                    <span
                      className={
                        m.scope === 'project'
                          ? 'shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] uppercase tracking-wide text-emerald-300/90'
                          : 'shrink-0 rounded bg-sky-500/15 px-1 text-[9px] uppercase tracking-wide text-sky-300/90'
                      }
                      title={m.scope === 'project' ? 'Project memory' : 'Global memory'}
                    >
                      {m.scope === 'project' ? 'proj' : 'glob'}
                    </span>
                    <span className="min-w-0 break-words">
                      {m.key || m.category ? <span className="font-medium">{m.key || m.category}</span> : null}
                      {m.snippet ? <span className="opacity-75"> — {m.snippet}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'error') {
        // Real generation/tool failure — red banner, never collapsed away.
        // Friendly copy up front; the raw upstream text sits in an
        // expandable details so power users can still see the provider's
        // exact words (the message-level Retry button re-runs the turn).
        const raw = block.rawContent;
        tagged.push({
          kind: 'block',
          node: (
            <div
              key={block.id || `error_${ti}`}
              role="alert"
              data-testid="chat-error-block"
              className="mx-3 my-1.5 flex items-start gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-300"
            >
              <span className="shrink-0" aria-hidden="true">
                ⚠
              </span>
              <span className="min-w-0 flex-1 break-words">
                {block.content || 'Generation failed.'}
                {raw ? (
                  <details className="mt-1 opacity-80">
                    <summary className="cursor-pointer select-none">
                      Show provider details
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-rose-950/40 p-2 font-mono text-[10px]">
                      {raw}
                    </pre>
                  </details>
                ) : null}
                {(onRetryTurn || onSwitchModel) && (
                  <div className="mt-1.5 flex items-center gap-2">
                    {onRetryTurn ? (
                      <button
                        type="button"
                        onClick={onRetryTurn}
                        className="rounded border border-rose-500/30 px-2 py-0.5 text-[10px] font-medium text-rose-200 hover:bg-rose-500/10 transition"
                      >
                        ↻ Retry
                      </button>
                    ) : null}
                    {onSwitchModel ? (
                      <button
                        type="button"
                        onClick={onSwitchModel}
                        className="rounded border border-rose-500/30 px-2 py-0.5 text-[10px] font-medium text-rose-200 hover:bg-rose-500/10 transition"
                      >
                        Switch model
                      </button>
                    ) : null}
                  </div>
                )}
              </span>
            </div>
          ),
        });
        ti++;
        continue;
      }

      // Non-process leftovers inside process list (ignore)
      ti++;
    }

    // Terminal rail marker once the turn settles. Gated off while the last
    // turn streams so it never flickers in the gap between steps.
    const hasRail = tagged.some((t) => t.kind === 'rail');
    if (withDoneMarker && hasRail && (!isLast || !streaming) && !anyToolRunning) {
      tagged.push({
        kind: 'rail',
        node: <RailDoneRow key="rail-done" errored={errorsCount > 0} />,
      });
    }

    // Group consecutive rail rows into segments (continuous left line); emit
    // block rows between them with the body's normal spacing.
    const out: ReactNode[] = [];
    let railBuf: ReactNode[] = [];
    let segSeq = 0;
    const flushRail = () => {
      if (railBuf.length === 0) return;
      out.push(
        <div key={`rail-seg-${keyPrefix}-${segSeq}`} className="process-rail-segment">
          {railBuf}
        </div>,
      );
      segSeq += 1;
      railBuf = [];
    };
    for (const t of tagged) {
      if (t.kind === 'rail') {
        railBuf.push(t.node);
      } else {
        flushRail();
        out.push(t.node);
      }
    }
    flushRail();
    return out;
  };

  /**
   * Plan §4.1 plan tree: `update_state` phase markers group the rows that
   * follow them — indent under the current step, highlight the active one,
   * auto-collapse finished subtrees. Flat fallback when the model emitted
   * no phases; the tree is never required for correctness (§4.2.7).
   */
  const renderProcessBlocks = (blocks: DisplayBlock[]) => {
    const phaseIdx: number[] = [];
    blocks.forEach((b, i) => {
      if (b.type === 'phase' && b.content && b.content.trim()) phaseIdx.push(i);
    });
    if (phaseIdx.length === 0) return renderFlatProcess(blocks, true, 'flat');

    const out: ReactNode[] = [];
    if (phaseIdx[0] > 0) {
      out.push(...renderFlatProcess(blocks.slice(0, phaseIdx[0]), false, 'pre'));
    }
    phaseIdx.forEach((start, gi) => {
      const end = gi + 1 < phaseIdx.length ? phaseIdx[gi + 1] : blocks.length;
      const phaseBlock = blocks[start];
      const phaseKey = phaseBlock.id || `phase_${start}`;
      // Active = the newest group while the turn still streams; finished
      // subtrees auto-collapse once the answer starts.
      const active = gi === phaseIdx.length - 1 && !!streaming && !hasFinalOutput;
      const expanded =
        phaseKey in expandOverrides ? expandOverrides[phaseKey] : active;
      out.push(
        <PlanPhaseGroup
          key={phaseKey}
          phase={(phaseBlock.content || '').trim()}
          step={phaseBlock.step}
          active={active}
          expanded={expanded}
          onToggle={(next) => toggleExpand(phaseKey, next)}
        >
          {renderFlatProcess(blocks.slice(start + 1, end), false, `ph${gi}`)}
        </PlanPhaseGroup>,
      );
    });

    // Terminal Done marker after the last group once the turn settles.
    const settled = !isLast || !streaming;
    const hasRailContent = blocks.some(
      (b) =>
        b.type === 'thinking' ||
        (b.type === 'toolCall' &&
          !!b.tool &&
          (classifyTool(b.tool.name) === 'edit' ||
            classifyTool(b.tool.name) === 'memoryWrite')),
    );
    if (settled && !anyToolRunning && hasRailContent) {
      out.push(
        <div key="rail-done-wrap" className="process-rail-segment">
          <RailDoneRow errored={errorsCount > 0} />
        </div>,
      );
    }
    return out;
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
          workersCount={subagentBlocks?.size ?? 0}
          filesTouched={filesTouched.size}
          searches={searchesCount}
          commands={commandsCount}
          errors={errorsCount}
          memoriesCount={memoriesCount}
          summary={livePacked ? null : processSummary}
          live={livePacked}
          liveDetail={
            livePacked && processBlocks.length === 0 && !liveDetail
              ? 'Working…'
              : liveDetail || null
          }
          defaultOpen={false}
          collapseWhen={hasFinalOutput}
          mode={toolsCount > 0 ? 'completion' : 'activity'}
          durationLabel={sequenceDurationLabel}
        >
          {showPendingThinking && (
            <ThoughtStep
              content=""
              isGenerating
              showFull={isThoughtExpanded('pending_think')}
              onToggle={() =>
                toggleExpand(
                  'pending_think',
                  !isThoughtExpanded('pending_think'),
                )
              }
              collapsedDefault={isCollapseThinkingEnabled()}
            />
          )}
          {renderProcessBlocks(processBlocks)}
        </ActivitySummary>
      )}
      {hasFinalOutput && renderFinal(finalBlocks)}
    </div>
  );
}
