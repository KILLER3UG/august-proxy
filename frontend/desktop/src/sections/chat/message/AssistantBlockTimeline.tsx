import { phaseLabel } from '@/lib/phase-labels';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Brain, ChevronDown, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Task, TaskContent, TaskTrigger } from '@/components/ui/task';
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
import { SubagentDelegateRow } from '@/components/chat/SubagentDelegateRow';
import { ActivityGroup } from '@/components/chat/ActivityGroup';
import { countSharedFiles, summarizeToolRun } from '@/lib/tool-summary';
import { splitThinkingSentences } from '@/lib/process-summary';
import { collectSnapshots, fromSnapshot, readSnapshot } from '../stream/subagent-blocks';
import { classifyTool, normalizeToolName } from '@/lib/tool-classify';
import { Markdown } from '../ChatMarkdown';
import { useSmoothReveal } from '../hooks/useSmoothReveal';
import type { ChatMessage, MessageBlock, SubagentSnapshot } from '@/types/chat';
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
import { resolveUiSessionId } from '../stream/session-id-map';

type DisplayBlock = MessageBlock;

/** Completed thinking sentences kept in the live feed per thinking block —
 *  the working indicator shows the last 3 lines, so older ones are ballast. */
const MAX_LIVE_THINKING_SENTENCES = 6;

/** update_state phase → present-continuous title for the "Working…" row. */
const PHASE_ACTION_TITLES: Record<string, string> = {
  research: 'Researching',
  plan: 'Planning',
  implement: 'Implementing',
  review: 'Reviewing',
  complete: 'Finalizing',
};

/** Answer markdown with the smooth character reveal applied while `live`.
 *  A component (not a hook call in a `.map`) so each final block owns its
 *  own rAF loop; when `live` is false it renders the full text directly. */
function RevealedMarkdown({ content, live }: { content: string; live: boolean }) {
  const revealed = useSmoothReveal(content, live);
  return <Markdown content={revealed} variant="assistant" live={live} />;
}

function isFinalOutput(block: DisplayBlock): boolean {
  return (
    block.type === 'finalOutput' &&
    !!(block.content && String(block.content).trim())
  );
}

/**
 * A tool block that can join an activity group.
 *
 * The reference transcript collapses the WHOLE run of tool work into one
 * line — a read, a command, a read is one thing that happened — and the
 * phrase names each kind. Three kinds stay OUT of a group:
 *
 *   - a subagent launch: it renders its own delegate row (and its own
 *     drawer), and that row is already a disclosure
 *   - `update_state`: bookkeeping, represented by the phase marker
 *   - a call that is waiting for approval, or that carries an action
 *     widget: an INTERACTIVE control the user has to see and click, and
 *     a collapsed line hides both
 *
 * A FAILURE is groupable. The reference groups failures and marks the
 * line, and the group OPENS on one, so the red is on screen without a
 * click. The old rule refused to group a failure at all, on the grounds
 * that a failure hidden behind a collapsed line is one nobody sees —
 * that reasoning is answered by opening the group, not by keeping the
 * failure out of it.
 */
function isGroupableToolBlock(block: DisplayBlock): boolean {
  if (block.type !== 'toolCall' && block.type !== 'command') return false;
  const tool = block.tool;
  if (!tool) return false;
  if (isSubagentToolName(tool.name)) return false;
  if (normalizeToolName(tool.name) === 'update_state') return false;
  if (tool.pendingApproval || tool.actionNeeded) return false;
  // Provider/integration setup widgets are interactive forms; the reference's
  // rule is that an action widget stays on its own. `actionNeeded` is only one
  // of the three widgets a tool result can carry.
  if (tool.providerSetup || tool.integrationSetup) return false;
  return true;
}

/**
 * A tool call that renders as NOTHING at all.
 *
 * `update_state` is bookkeeping: the phase marker already says the turn
 * moved on, so a duplicate row is noise. A block that renders as nothing
 * must not BREAK a run either — the blocks on either side of it are
 * adjacent on screen, and adjacent work is one line. A FAILED
 * `update_state` does render, so it is not invisible bookkeeping and it
 * does break the run.
 */
function isInvisibleBookkeeping(block: DisplayBlock): boolean {
  return (
    block.type === 'toolCall' &&
    !!block.tool &&
    normalizeToolName(block.tool.name) === 'update_state' &&
    block.tool.status !== 'error'
  );
}

/** One memo per string for pure JSON-arg extractors. The timeline re-renders
 *  the last row on every stream flush, and each render used to JSON.parse
 *  every visible tool's args again (measured cost, audit 2026-09-27). */
function memoizeByString<A extends string | undefined, R>(fn: (a: A) => R): (a: A) => R {
  const cache = new Map<string, R>();
  return (a: A): R => {
    const key = a ?? '';
    if (cache.has(key)) return cache.get(key) as R;
    const value = fn(a);
    if (cache.size > 200) cache.clear();
    cache.set(key, value);
    return value;
  };
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

/** Best-effort task/agent extraction from a spawn_subagent tool's JSON args —
 *  used by the inline delegate row when the live container is gone (reloaded
 *  transcript). Returns '' task when the context isn't parseable. */
function parseSubagentToolContext(context?: string): { task: string; agentId: string } {
  if (!context) return { task: '', agentId: '' };
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>;
    const task = ['task', 'prompt', 'goal', 'description', 'userMessage', 'message']
      .map((k) => parsed?.[k])
      .find((v): v is string => typeof v === 'string' && !!v.trim());
    const agent = ['agentId', 'agent_id', 'agent', 'role']
      .map((k) => parsed?.[k])
      .find((v): v is string => typeof v === 'string' && !!v.trim());
    return { task: (task || '').trim().slice(0, 160), agentId: (agent || '').trim() };
  } catch {
    return { task: '', agentId: '' };
  }
}

const extractSearchQueryCached = memoizeByString(extractSearchQuery);
const parseSubagentToolContextCached = memoizeByString(parseSubagentToolContext);

/** "6s" / "1m 06s" — total elapsed for a tool-execution sequence. */
function formatSequenceDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Split blocks into process (thinking/tools) vs final answer. Error blocks
 *  are pulled out entirely — they render as a standalone message bubble below
 *  the timeline, never buried inside the collapsible activity pack (a failed
 *  turn left the only visible trace behind a collapsed "Task completed" row).
 *  System notices (retry warnings, context pressure, infos) are likewise
 *  pulled out — the thinking pack holds ONLY model chain-of-thought. */
function splitProcessAndFinal(blocks: DisplayBlock[]): {
  processBlocks: DisplayBlock[];
  finalBlocks: DisplayBlock[];
  errorBlocks: DisplayBlock[];
  noticeBlocks: DisplayBlock[];
  subagentBlocks: DisplayBlock[];
  hasFinalOutput: boolean;
} {
  let lastFinalIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (isFinalOutput(blocks[i])) lastFinalIdx = i;
  }
  const processBlocks: DisplayBlock[] = [];
  const finalBlocks: DisplayBlock[] = [];
  const errorBlocks: DisplayBlock[] = [];
  const noticeBlocks: DisplayBlock[] = [];
  const subagentBlocks: DisplayBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'error') {
      errorBlocks.push(block);
    } else if (block.type === 'system') {
      noticeBlocks.push(block);
    } else if (block.type === 'subagent') {
      subagentBlocks.push(block);
    } else if (isFinalOutput(block)) {
      if (i === lastFinalIdx) finalBlocks.push(block);
      else processBlocks.push({ ...block, type: 'thinking' });
    } else {
      processBlocks.push(block);
    }
  }
  return {
    processBlocks,
    finalBlocks,
    errorBlocks,
    noticeBlocks,
    subagentBlocks,
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
        className="flex w-full min-w-0 items-center gap-1.5 rounded-xs px-1 py-0.5 text-left text-[0.75rem] font-medium text-foreground/75 hover:bg-accent hover:text-foreground"
        data-testid="plan-phase-head"
      >
        <ChevronDown
          className={cn(
            'size-3 shrink-0 transition-transform',
            !expanded && '-rotate-90',
          )}
          aria-hidden
        />
        {/* The phase's NAME, humanised. The heading rendered the raw enum
            value, so a group read "research" in lower case — a value from
            the tool contract, not a title. */}
        <span className="min-w-0 flex-1 truncate" title={phaseLabel(phase)}>
          {phaseLabel(phase)}
          {typeof step === 'number' ? (
            <span className="ml-1 font-normal text-muted-foreground/70">
              · step {step}
            </span>
          ) : null}
        </span>
        {active ? (
          <span className="shrink-0 text-2xs italic text-muted-foreground/70">
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

/** A settled or active sub-agent whose live block was evicted (reloaded
 *  transcript, SSE close, drawer reset). Renders inline as a one-row stub
 *  so the user can still see "what ran" at the spawn call's position. */
export interface InlineSubagentRosterEntry {
  jobId: string;
  agentId: string;
  task: string;
  status: 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'done' | 'error';
  startedAt?: number;
  finishedAt?: number;
  workstream?: string;
}

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
  subagentRoster,
  modelId,
  sessionId,
  onRetryTurn,
  onSwitchModel,
  onDismissError,
}: {
  displayBlocks: DisplayBlock[];
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  showPendingThinking: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  /** Keyed by sub-agent jobId; rendered inline via SubagentDelegateRow
   *  (and in the persistent right-drawer roster). */
  subagentBlocks?: Map<string, SubagentBlockState>;
  /** Settled/active runs whose live SSE block is gone (the keystone of
   *  delegation visibility after reload). Merged with subagentBlocks so
   *  a spawn call always renders at least one row. */
  subagentRoster?: ReadonlyArray<InlineSubagentRosterEntry>;
  /** Parent session model id — shown as muted tag on subagent launch rows. */
  modelId?: string | null;
  /** Chat session id — keys the per-session /verbose flag. */
  sessionId?: string | null;
  /** Rendered on error blocks: re-run the turn from the last user prompt. */
  onRetryTurn?: () => void;
  /** Rendered on error blocks: open the "answer with another model" picker. */
  onSwitchModel?: () => void;
  /** Rendered on error blocks: dismiss the error bubble (removes the block). */
  onDismissError?: () => void;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const liveSessionKey = resolveUiSessionId(routeSessionId || message.id);
  // /verbose: raw tool output renders inline for this
  // session until turned off. Rendering policy only — data layer unchanged.
  const verbose = useVerboseMode(sessionId);
  // Kept in the public props for message-pane compatibility; subagent
  // progress no longer renders an inline model label.
  void modelId;

  const {
    processBlocks,
    finalBlocks,
    errorBlocks,
    noticeBlocks,
    subagentBlocks: persistedSubagentBlocks,
    hasFinalOutput,
  } = splitProcessAndFinal(displayBlocks);

  // One row per worker, from three sources that overlap by design:
  //   1. the live `subagentBlocks` map (SSE, this session),
  //   2. the `subagent` blocks on this message (persisted with the transcript),
  //   3. the backend roster (settled runs whose SSE block was evicted).
  // A job already rendered from a live container is skipped by the later
  // sources, which is what stops a reconnected session from showing the same
  // worker twice — once live, once restored.
  const liveSubagentStates = useMemo(
    () => new Map(subagentBlocks ?? []),
    [subagentBlocks],
  );
  const persistedSubagentStates = useMemo(
    () => collectSnapshots(persistedSubagentBlocks).map(fromSnapshot),
    [persistedSubagentBlocks],
  );
  /** Every worker this message can show, live snapshot preferred. */
  const allSubagentStates = useMemo(() => {
    const out = new Map<string, SubagentBlockState>();
    for (const state of persistedSubagentStates) out.set(state.jobId, state);
    for (const [jobId, state] of liveSubagentStates) out.set(jobId, state);
    return new Map(
      [...out.entries()].sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0)),
    );
  }, [persistedSubagentStates, liveSubagentStates]);

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
  // The phrase the collapsed line will carry: what the turn DID, in the
  // reference's words ("Running a command", "Ran a command, edited a
  // file"). A run of two or more groupable calls has a phrase; a lone
  // call renders as its own row, and the thinking gist stands in for it.
  const groupableTools = processBlocks
    .filter((b) => isGroupableToolBlock(b) && b.tool)
    .map((b) => b.tool!);
  const workPhrase =
    groupableTools.length > 1 ? summarizeToolRun(groupableTools) : null;

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
  // The tool durations are the OTHER clock. A tool block that carries a
  // duration but no startedAt - a restored transcript, a merged one - still
  // knows how long it took, and the ActivityGroup's own elapsed already
  // uses that number. The header must not disagree with the group it sits
  // above, so the wall-clock span is preferred and the durations are the
  // fallback, not a second answer.
  const summedToolMs = processBlocks.reduce(
    (sum, b) =>
      sum +
      ((b.type === 'toolCall' || b.type === 'command') && b.tool
        ? (b.tool.duration ?? 0)
        : 0),
    0,
  );
  const sequenceDurationLabel =
    Number.isFinite(seqStart) && (anyToolRunning || seqEnd > seqStart)
      ? formatSequenceDuration(
          (anyToolRunning ? nowMs : seqEnd) - seqStart,
        )
      : summedToolMs > 0
        ? formatSequenceDuration(summedToolMs)
        : null;

  const { liveDetail, liveItems } = useMemo(() => {
    const items: LiveActivityItem[] = [];
    // The "Working…" row shows a TITLE of what the model is doing — never a
    // thinking snippet (the CoT already streams above the composer in the
    // WorkingIndicator). Priority: running tool > update_state phase >
    // last completed tool > generic Thinking….
    let runningTitle = '';
    let completedTitle = '';
    let phaseTitle = '';
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
      }
      if (block.type === 'phase') {
        const phase = (block.content || '').trim().toLowerCase();
        phaseTitle = PHASE_ACTION_TITLES[phase] || '';
      }
      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const bucket = classifyTool(block.tool.name) as LiveActivityKind;
        const kind: LiveActivityKind =
          bucket === 'view' || bucket === 'edit' || bucket === 'run' ? bucket : 'tool';
        const toolStatus =
          block.tool.status === 'error'
            ? ('error' as const)
            : block.tool.status === 'running'
              ? ('running' as const)
              : ('done' as const);
        const label = getToolLabel(block.tool.name, {
          status: toolStatus,
          command: extractCommand(block.tool.context) ?? undefined,
          filename: extractFilename(block.tool.context) ?? undefined,
          agentId: extractAgentId(block.tool.context) ?? undefined,
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
        if (block.tool.status === 'running') {
          runningTitle = label;
        } else {
          completedTitle = label;
        }
      }
    }
    let liveDetail = runningTitle || phaseTitle || completedTitle;
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
        const toolId = tool.id || block.id || `tool_${ti}`;

        // Subagent launches render one inline row per agent —
        // the keystone of delegation visibility (reverses the 265ba24a
        // "drawer-only" decision). Live containers drive rich rows; a spawn
        // call whose workers already streamed out (reloaded transcript)
        // still renders one settled row from the tool block itself.
        if (isSubagentCall) {
          // A1 keystone: live SSE containers first, then the persisted
          // transcript's own `subagent` blocks (the reload / reconnect case
          // that used to leave a bare stub with no output), then the backend
          // roster for runs that predate this message, then a stub from the
          // spawn tool's own context as the last-resort fallback. Each source
          // is filtered against the ones above it, so a worker renders once.
          const liveContainers = subagentBlocks
            ? Array.from(subagentBlocks.values())
                .filter((s) => s.parentToolId === tool.id)
                .sort((a, b) => a.startedAt - b.startedAt)
            : [];
          const claimed = new Set(liveContainers.map((c) => c.jobId));
          const persistedForTool = persistedSubagentStates.filter((s) => {
            if (claimed.has(s.jobId)) return false;
            if (s.parentToolId !== tool.id) return false;
            claimed.add(s.jobId);
            return true;
          });
          const rosterForTool = (subagentRoster ?? []).filter((r) => {
            if (!r.jobId || claimed.has(r.jobId)) return false;
            claimed.add(r.jobId);
            return true;
          });

          if (liveContainers.length > 0) {
            for (const c of liveContainers) {
              tagged.push({
                kind: 'block',
                node: (
                  <SubagentDelegateRow
                    key={c.jobId}
                    jobId={c.jobId}
                    agentId={c.agentId}
                    task={c.task || ''}
                    status={c.status}
                    startedAt={c.startedAt}
                    finishedAt={c.finishedAt}
                    workstream={c.workstream}
                    state={c}
                    defaultExpanded
                    sessionId={liveSessionKey}
                  />
                ),
              });
            }
          } else if (persistedForTool.length > 0) {
            // The reload path: the transcript carries the worker's own
            // timeline, so the row expands inline without any SSE replay.
            for (const s of persistedForTool) {
              tagged.push({
                kind: 'block',
                node: (
                  <SubagentDelegateRow
                    key={`sub_block_${s.jobId}`}
                    jobId={s.jobId}
                    agentId={s.agentId}
                    task={s.task || ''}
                    status={s.status}
                    startedAt={s.startedAt}
                    finishedAt={s.finishedAt}
                    workstream={s.workstream}
                    state={s}
                    sessionId={liveSessionKey}
                  />
                ),
              });
            }
          } else if (rosterForTool.length > 0) {
            for (const r of rosterForTool) {
              tagged.push({
                kind: 'block',
                node: (
                  <SubagentDelegateRow
                    key={`roster_${r.jobId}`}
                    jobId={r.jobId}
                    agentId={r.agentId}
                    task={r.task}
                    status={r.status}
                    startedAt={r.startedAt}
                    finishedAt={r.finishedAt}
                    workstream={r.workstream}
                    state={allSubagentStates.get(r.jobId)}
                    sessionId={liveSessionKey}
                  />
                ),
              });
            }
          } else {
            const ctx = parseSubagentToolContextCached(tool.context);
            tagged.push({
              kind: 'block',
              node: (
                <SubagentDelegateRow
                  key={toolId}
                  agentId={ctx.agentId || 'general'}
                  task={ctx.task}
                  status={
                    tool.status === 'error'
                      ? 'failed'
                      : tool.status === 'running'
                        ? 'running'
                        : 'completed'
                  }
                  startedAt={tool.startedAt}
                  sessionId={liveSessionKey}
                />
              ),
            });
          }
          ti++;
          continue;
        }

        // A run of tool work collapses into ONE activity line — the
        // reference's "Ran 4 commands, read a file" — with the individual
        // calls inside a bordered card when it is opened.
        //
        // The grouping is a RENDER-TIME arrangement, not a new persisted
        // block kind: the transcript still stores one block per call, so a
        // reload produces the same grouping and the backend needs to know
        // nothing about it.
        //
        // EVERY kind joins: reads, commands, edits, memory writes, plain
        // tool calls. A mixed run (a read, a command, a read) is one thing
        // that happened, so it is one line — and the phrase names each
        // kind. A run of reads used to keep the Explore group it had
        // ("Explore · 2 searches, 3 files"); that group and its vocabulary
        // are gone, merged into this one.
        const runBlocks: DisplayBlock[] = [];
        let tj = ti;
        while (tj < blocks.length) {
          const nb = blocks[tj];
          if (isGroupableToolBlock(nb)) {
            runBlocks.push(nb);
            tj += 1;
            continue;
          }
          // A call that renders as nothing must not break the run: the
          // blocks on either side of it are adjacent on screen.
          if (isInvisibleBookkeeping(nb)) {
            tj += 1;
            continue;
          }
          break;
        }
        if (runBlocks.length >= 2) {
          const runTools = runBlocks
            .map((b) => b.tool)
            .filter((t): t is NonNullable<typeof t> => !!t);
          const anyRunning = runTools.some((t) => t.status === 'running');
          // A run that FAILED opens. The group used to refuse to group a
          // failure at all, because a failure behind a collapsed line is
          // one nobody sees; opening the group answers that, so the
          // failure is grouped AND visible without a click.
          const hasFailure = runTools.some((t) => t.status === 'error');
          const elapsedMs = runTools.reduce(
            (sum, t) => sum + (typeof t.duration === 'number' ? t.duration : 0),
            0,
          );
          /* The files this run SHARED. The reference's expanded card ends
             with a row naming them - "Presented 2 files" - and the count is
             the same rule the phrase and the artifact cards use, so the
             three cannot disagree about what the turn produced. */
          const sharedFiles = countSharedFiles(runTools);
          const groupKey = `activity_${toolId}`;
          const groupOpen =
            groupKey in expandOverrides
              ? expandOverrides[groupKey]
              : anyRunning || hasFailure;
          tagged.push({
            kind: 'block',
            node: (
              <ActivityGroup
                key={groupKey}
                groupKey={groupKey}
                summary={summarizeToolRun(runTools)}
                elapsedMs={elapsedMs}
                running={anyRunning}
                failed={hasFailure}
                expanded={groupOpen}
                onToggle={(next) => toggleExpand(groupKey, next)}
              >
                {runBlocks.map((rb, ri) => {
                  const rt = rb.tool!;
                  const rtId = rt.id || `activity_child_${ti + ri}`;
                  const rbIsCommand = rb.type === 'command';
                  return (
                    <ToolStepRow
                      key={rtId}
                      tool={rt}
                      label={getToolLabel(rt.name, {
                        command: rbIsCommand
                          ? extractCommand(rt.context) ?? undefined
                          : undefined,
                        filename: !rbIsCommand
                          ? extractFilename(rt.context) ?? undefined
                          : undefined,
                        status: rt.status,
                      })}
                      isCommand={rbIsCommand}
                      /* A failed row opens with the group, so the error
                         text is on screen without a second click. */
                      expanded={
                        rtId in expandOverrides
                          ? expandOverrides[rtId]
                          : rt.status === 'error'
                      }
                      verbose={verbose}
                      onToggle={(next) => toggleExpand(rtId, next)}
                      progress={rt.id ? toolProgress?.get(rt.id) : undefined}
                    >
                      <ToolCallItemBody tool={rt} verbose={verbose} />
                    </ToolStepRow>
                  );
                })}
                {sharedFiles > 0 ? (
                  <div
                    key={`presented_${groupKey}`}
                    className="py-1.5 text-[0.71875rem] text-muted-foreground"
                    data-testid="activity-group-presented"
                  >
                    Presented{' '}
                    {sharedFiles} {sharedFiles === 1 ? 'file' : 'files'}
                  </div>
                ) : null}
              </ActivityGroup>
            ),
          });
          ti = tj;
          continue;
        }

        // update_state bookkeeping is represented by the phase marker
        // itself — a duplicate "Edited state" rail
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
                query={extractSearchQueryCached(tool.context)}
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
        // expanded by default to show the saved entry text.
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

        // Consecutive reads of the same file used to collapse into one row:
        // `read consolidation.py ×4`. That path is gone — a run of two or
        // more reads is an activity group now, so the consolidation could
        // only ever have fired for a single read, which is not a
        // consolidation. The group shows every call, one row each.

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
              className="mx-3 my-1 inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-2xs text-muted-foreground"
              title={block.content || undefined}
            >
              <Brain className="size-3 shrink-0 opacity-70" aria-hidden />
              <span className="truncate">{block.content || 'Memory updated'}</span>
            </div>
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'recalledMemories' && block.memories && block.memories.length > 0) {
        // Part 17 A.4 (gap C-13): what the per-turn memory tail actually
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
            <Task
              key={block.id || `recall_${ti}`}
              defaultOpen={false}
              data-testid="recalled-memories-block"
              className="mx-3 my-1 block max-w-full rounded border border-border/60 bg-muted/40 px-2.5 py-1 text-2xs text-muted-foreground"
            >
              <TaskTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="h-auto w-full gap-1.5 justify-start px-0 py-0 text-2xs font-normal">
                  <ChevronDown className="disclosure-chevron shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
                  <span className="truncate">{label}</span>
                </Button>
              </TaskTrigger>
              <TaskContent className="mt-1">
              <ul className="space-y-1 pl-1">
                {rows.map((m) => (
                  <li key={m.id} className="flex items-start gap-1.5">
                    <span
                      className={
                        m.scope === 'project'
                          ? 'shrink-0 rounded bg-success/15 px-1 text-2xs uppercase tracking-wide text-success-fg'
                          : 'shrink-0 rounded bg-info/15 px-1 text-2xs uppercase tracking-wide text-info'
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
              </TaskContent>
            </Task>
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
   * no phases; the tree is never required for correctness.
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
            <RevealedMarkdown content={block.content} live={isFinalStreaming} />
          </div>
        </div>
      );
    });

  const renderSystemNotices = (blocks: DisplayBlock[]) =>
    blocks.map((block, index) => {
      // Harness notice (retry warning, context pressure, info) — a muted
      // inline strip below the answer, never inside the thinking pack: the
      // Thinking disclosure holds only the model's chain-of-thought.
      const key = block.id || `notice_${index}`;
      return (
        <div
          key={key}
          data-testid="chat-system-notice"
          className="mt-1 flex w-full items-start gap-2 text-2xs leading-relaxed text-muted-foreground/80"
        >
          <Settings className="mt-px size-3 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 flex-1">{block.content}</span>
        </div>
      );
    });

  /**
   * Persisted worker rows that no spawn tool call claims.
   *
   * The backend only reports `parentToolUseId` when a worker was launched
   * from inside a tool call; otherwise the block is anchored to the newest
   * assistant message with no matching `toolCall` block. Rendering it here
   * (outside the activity pack, next to the answer) is what stops a
   * reconnected session from silently dropping a worker's output.
   */
  const renderOrphanSubagentRows = (blocks: DisplayBlock[]) => {
    const claimed = new Set<string>();
    for (const block of blocks) {
      if (block.type !== 'toolCall' && block.type !== 'command') continue;
      if (!block.tool) continue;
      for (const state of allSubagentStates.values()) {
        if (state.parentToolId === block.tool.id) claimed.add(state.jobId);
      }
    }
    const orphans = blocks
      .map((block) => readSnapshot(block))
      .filter((s): s is SubagentSnapshot => !!s && !claimed.has(s.jobId))
      .map(fromSnapshot);
    if (orphans.length === 0) return null;
    return (
      <div className="mt-1 space-y-1" data-testid="subagent-orphan-rows">
        {orphans.map((s) => (
          <SubagentDelegateRow
            key={`orphan_${s.jobId}`}
            jobId={s.jobId}
            agentId={s.agentId}
            task={s.task || ''}
            status={s.status}
            startedAt={s.startedAt}
            finishedAt={s.finishedAt}
            workstream={s.workstream}
            state={s}
            sessionId={liveSessionKey}
          />
        ))}
      </div>
    );
  };

  const renderErrorBubble = (blocks: DisplayBlock[]) =>
    blocks.map((block, index) => {
      // A provider/turn failure rendered as its OWN message bubble — left
      // aligned like the model's replies, with the friendly copy up front,
      // the raw upstream text behind an expandable details, a Try again
      // action, and a corner ✕ to dismiss. Never collapsed into the activity
      // pack: a failed turn must be impossible to miss.
      const raw = block.rawContent;
      const key = block.id || `error_${index}`;
      return (
        <div
          key={key}
          role="alert"
          data-testid="chat-error-bubble"
          className="mt-1.5 flex w-full items-start gap-2.5"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-danger/30 bg-danger/15 text-[0.8125rem] text-danger-fg"
          >
            !
          </span>
          <div className="relative min-w-0 flex-1 rounded-2xl border border-danger/30 bg-danger/[0.07] px-4 py-3">
            {onDismissError ? (
              <button
                type="button"
                onClick={onDismissError}
                aria-label="Dismiss error"
                data-testid="chat-error-dismiss"
                className="absolute right-2 top-2 flex size-5 items-center justify-center rounded text-danger-fg transition hover:bg-danger/15 hover:text-danger-fg"
              >
                ✕
              </button>
            ) : null}
            <div className="pr-5 text-[0.8125rem] leading-relaxed text-danger-fg">
              {block.content || 'Generation failed.'}
            </div>
            {raw ? (
              <Task defaultOpen={false} className="mt-1.5 block text-[0.75rem] text-danger-fg">
                <TaskTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="h-auto gap-1.5 px-0 py-0 text-[0.75rem] font-normal">
                    <ChevronDown className="disclosure-chevron shrink-0 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
                    Show provider details
                  </Button>
                </TaskTrigger>
                <TaskContent className="mt-1">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-danger/40 p-2 font-mono text-2xs">
                    {raw}
                  </pre>
                </TaskContent>
              </Task>
            ) : null}
            {(onRetryTurn || onSwitchModel) && (
              <div className="mt-2.5 flex items-center gap-2">
                {onRetryTurn ? (
                  <button
                    type="button"
                    onClick={onRetryTurn}
                    data-testid="chat-error-retry"
                    className="inline-flex items-center gap-1 rounded-lg border border-danger/40 bg-danger/15 px-2.5 py-1 text-2xs font-medium text-danger-fg transition hover:bg-danger/25"
                  >
                    ↻ Try again
                  </button>
                ) : null}
                {onSwitchModel ? (
                  <button
                    type="button"
                    onClick={onSwitchModel}
                    className="rounded-lg border border-danger/30 px-2.5 py-1 text-2xs font-medium text-danger-fg transition hover:bg-danger/10"
                  >
                    Switch model
                  </button>
                ) : null}
              </div>
            )}
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
          summary={livePacked ? null : workPhrase || processSummary}
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
      {renderOrphanSubagentRows(persistedSubagentBlocks)}
      {noticeBlocks.length > 0 && renderSystemNotices(noticeBlocks)}
      {errorBlocks.length > 0 && renderErrorBubble(errorBlocks)}
    </div>
  );
}
