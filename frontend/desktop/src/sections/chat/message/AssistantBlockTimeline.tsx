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
import { EditRailRow } from '@/components/chat/EditRailRow';
import { RailDoneRow } from '@/components/chat/RailDoneRow';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { RecalledMemoryStep } from '@/components/chat/RecalledMemoryStep';
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
import { resolveUiSessionId, resolveWorkbenchSessionId } from '../stream/session-id-map';
import { toast } from 'sonner';
import { api } from '@/api/client';

type DisplayBlock = MessageBlock;

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
  /** Retained for stream-store compatibility; the roster lives in the drawer. */
  subagentBlocks?: Map<string, SubagentBlockState>;
  /** Parent session model id — shown as muted tag on subagent launch rows. */
  modelId?: string | null;
  /** Rendered on error blocks: re-run the turn from the last user prompt. */
  onRetryTurn?: () => void;
  /** Rendered on error blocks: open the "answer with another model" picker. */
  onSwitchModel?: () => void;
}) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const liveSessionKey = resolveUiSessionId(routeSessionId || message.id);
  // Kept in the public props for message-pane compatibility; subagent
  // progress no longer renders an inline model label.
  void modelId;
  void subagentBlocks;

  const { processBlocks, finalBlocks, hasFinalOutput } =
    splitProcessAndFinal(displayBlocks);

  // Id-keyed expand overrides; missing key → default from status.
  // Tools: running → open, else collapsed. Thoughts: open while generating,
  // collapse once the final answer exists (unless the user overrode).
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>(

    {},
  );
  // Verifier banner "Run it for me" in-flight flag.
  const [verifierRunning, setVerifierRunning] = useState(false);

  // When the turn finishes, drop expand overrides so thoughts re-collapse.
  useEffect(() => {
    if (!streaming && hasFinalOutput) {
      setExpandOverrides({});
    }
  }, [streaming, hasFinalOutput]);

  const toggleExpand = (id: string, next: boolean) => {
    setExpandOverrides((prev) => ({ ...prev, [id]: next }));
  };

  const isToolExpanded = (toolId: string, status: string | undefined) => {
    if (toolId in expandOverrides) return expandOverrides[toolId];
    // Open while running; once complete the block keeps whatever state the
    // user left it in (ToolStepRow never force-collapses on completion).
    return status === 'running';
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
  }
  // Total elapsed for the whole tool-execution sequence (not per-tool).
  const sequenceDurationLabel =
    !anyToolRunning && Number.isFinite(seqStart) && seqEnd > seqStart
      ? formatSequenceDuration(seqEnd - seqStart)
      : null;
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
            />
          ),
        });
        continue;
      }

      if ((block.type === 'toolCall' || block.type === 'command') && block.tool) {
        const tool = block.tool;
        const isCommand = block.type === 'command';
        const isSubagentCall = !isCommand && isSubagentToolName(tool.name);

        // Consume consecutive subagent launch blocks; live progress is shown
        // in the persistent right drawer.
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
          // Subagent progress is rendered in the persistent right drawer.
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
        const expanded = isToolExpanded(toolId, tool.status);

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

        const label = getToolLabel(tool.name, {
          agentId: agentId ?? undefined,
          filename: filename ?? undefined,
          command: isCommand ? extractCommand(tool.context) ?? undefined : undefined,
          status: tool.status,
        });
        tagged.push({
          kind: 'block',
          node: (
            <ToolStepRow
              key={toolId}
              tool={tool}
              label={label}
              isCommand={isCommand}
              expanded={expanded}
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
              />
            </ToolStepRow>
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'recalledMemories' && block.memories && block.memories.length > 0) {
        const recallId = block.id || `recall_${ti}`;
        const recallExpanded = isToolExpanded(recallId, 'done');
        tagged.push({
          kind: 'block',
          node: (
            <RecalledMemoryStep
              key={recallId}
              memories={block.memories}
              expanded={recallExpanded}
              onToggle={() => toggleExpand(recallId, !recallExpanded)}
            />
          ),
        });
        ti++;
        continue;
      }

      if (block.type === 'memoryNotice') {
        // In-chat notice: August remembered / updated / forgot a memory.
        tagged.push({
          kind: 'block',
          node: (
            <div
              key={block.id || `memory_${ti}`}
              className="mx-3 my-1 flex items-start gap-1.5 rounded-md border border-border/40 bg-card/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
            >
              <span aria-hidden="true" className="shrink-0">
                🧠
              </span>
              <span className="min-w-0 break-words">
                {block.content || 'August updated its memory.'}
              </span>
            </div>
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

      if (block.type === 'verifierBlocked') {
        // Opt-in verifier enforcement: final answer withheld until the model
        // passes update_state(phase='complete'). Amber notice + gate evidence
        // (phase, blockers, verification command) so the user sees WHY.
        const ev = block.verifierEvidence;
        tagged.push({
          kind: 'block',
          node: (
            <div
              key={block.id || `verifier_${ti}`}
              role="alert"
              data-testid="verifier-blocked-banner"
              className="mx-3 my-1.5 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300"
            >
              <span className="shrink-0" aria-hidden="true">
                ⚠
              </span>
              <div className="min-w-0 break-words">
                {block.content || 'Verification required: the final answer was withheld.'}
                {ev ? (
                  <ul className="mt-1.5 space-y-0.5 text-[10px] text-amber-200/80">
                    {ev.currentPhase ? (
                      <li>
                        <span className="font-medium">Current phase:</span> {ev.currentPhase}
                      </li>
                    ) : null}
                    {ev.receiptCount === 0 ? (
                      <li>
                        <span className="font-medium">No verification command ran</span> this turn —
                        run the test/lint/build command, confirm it passes, then call{' '}
                        <code className="font-mono">update_state(phase=&quot;complete&quot;)</code>.
                      </li>
                    ) : (
                      <li>
                        <span className="font-medium">{ev.receiptCount} command receipt(s)</span>{' '}
                        recorded this turn.
                      </li>
                    )}
                    {ev.verificationCommand ? (
                      <li>
                        <span className="font-medium">Verification command:</span>{' '}
                        <code className="font-mono">{ev.verificationCommand}</code>
                      </li>
                    ) : null}
                    {ev.blockers && ev.blockers.length > 0 ? (
                      <li>
                        <span className="font-medium">Model-stated blockers:</span>{' '}
                        {ev.blockers.join(' · ')}
                      </li>
                    ) : null}
                    {ev.verificationCommand ? (
                      <li className="flex items-center gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(ev.verificationCommand ?? '')
                              .catch(() => undefined);
                            toast.success('Command copied');
                          }}
                          className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/25"
                          data-testid="verifier-copy-command"
                        >
                          Copy command
                        </button>
                        <button
                          type="button"
                          disabled={verifierRunning}
                          onClick={() => {
                            setVerifierRunning(true);
                            const wbId = resolveWorkbenchSessionId(liveSessionKey);
                            api
                              .post<{ status: string; output?: string; error?: string }>(
                                `/api/workbench/sessions/${encodeURIComponent(wbId)}/verify-run`,
                                { command: ev.verificationCommand ?? '' },
                              )
                              .then((res) => {
                                if (res.status === 'ok') {
                                  toast.success(
                                    'Verification ran — August was told to finish the gate',
                                  );
                                } else {
                                  toast.error(res.error || 'Verification run failed');
                                }
                              })
                              .catch((err: Error) =>
                                toast.error(err.message || 'Verification run failed'),
                              )
                              .finally(() => setVerifierRunning(false));
                          }}
                          className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                          data-testid="verifier-run-command"
                        >
                          {verifierRunning ? 'Running…' : 'Run it for me'}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </div>
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
    if (hasRail && (!isLast || !streaming) && !anyToolRunning) {
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
        <div key={`rail-seg-${segSeq}`} className="process-rail-segment">
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
          filesTouched={filesTouched.size}
          searches={searchesCount}
          commands={commandsCount}
          errors={errorsCount}
          summary={processSummary}
          live={livePacked}
          liveDetail={liveDetail || null}
          defaultOpen={livePacked && !hasFinalOutput}
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
            />
          )}
          {renderProcessBlocks(processBlocks)}
        </ActivitySummary>
      )}
      {hasFinalOutput && renderFinal(finalBlocks)}
    </div>
  );
}
