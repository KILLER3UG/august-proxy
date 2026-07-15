/* ── Message bubble + tool cards ─────────────────────────────────────── */
/* Renders a single chat message: text, thinking, tool calls, and badges. */

import { useState, useEffect, useMemo } from 'react';
import {
  Check,
  Loader2,
  AlertCircle,
  CircleDot,
  FileSearch,
  Code2,
  RefreshCw,
  Play,
  Pause,
  Bug,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { cn, formatClockTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ThinkingDisclosure } from '@/components/chat/ThinkingDisclosure';
import {
  ToolCallItem as ToolCallItemComp,
  ToolCallItemBody,
  extractAgentId,
} from '@/components/chat/ToolCallItem';
import { ToolSummary, buildToolSummaryEntry } from '@/components/chat/ToolSummary';
import { ActivitySummary } from '@/components/chat/ActivitySummary';
import { RecapCard } from '@/components/chat/RecapCard';
import { ToolIcon as NewToolIcon } from '@/components/ui/ToolIcon';
import { FileIcon as NewFileIcon } from '@/components/ui/FileIcon';
import { DisclosureRow } from '@/components/chat/DisclosureRow';
import { ClarifyTool } from '@/components/chat/ClarifyTool';
import { PromptDisclosure } from '@/components/chat/PromptDisclosure';
import { visibleProgress } from '@/lib/tool-progress';
import { getToolLabel } from '@/lib/tool-labels';
import { classifyTool } from '@/lib/tool-classify';
import { WorkingIndicator } from '@/components/chat/WorkingIndicator';
import { SubagentBlock } from '@/components/chat/SubagentBlock';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import { Markdown } from './ChatMarkdown';
import { CommandHelpCard } from './CommandHelpCard';
import { getFileIcon } from '@/lib/file-icon';
import type { ChatMessage, MessageBlock, ToolProgressEntry } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import { getDisplayBlocks } from './message-blocks';
import { modelDisplayParts } from './model-display';
import {
  voiceCommandRegistry,
  type VoiceCommandCardProps,
} from '@/api/voice/registry';

const LONG_MSG_THRESHOLD = 1000;

export function ReasoningBlock({
  text,
  segments,
  isGenerating,
  duration,
  omitDurationLabel,
  thoughtCount,
}: {
  /** Single thinking body (used when `segments` is not provided). */
  text?: string;
  /**
   * Multiple thinking segments collapsed under one header. When expanded,
   * each segment renders the normal thought style (border-l + markdown).
   */
  segments?: string[];
  isGenerating?: boolean;
  duration?: number;
  /** Suppress "Thought for Xs" when a following ToolSummary already badges thought count. */
  omitDurationLabel?: boolean;
  /**
   * When multiple thinking segments were merged into one disclosure, show
   * e.g. "Thinking (3)" / "Thought (3)". Single thoughts use the normal label.
   */
  thoughtCount?: number;
}) {
  // Live-tick the elapsed time in the Thinking label while the model is
  // thinking. The interval stops as soon as this thinking section is done.
  const [elapsed, setElapsed] = useState<number>(0);
  useEffect(() => {
    if (!isGenerating) return;
    const startedAt = Date.now();
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [isGenerating]);

  const parts = (segments && segments.length > 0
    ? segments
    : text
      ? [text]
      : []
  ).map((s) => s.trim()).filter(Boolean);

  const n = thoughtCount ?? parts.length;
  // Only badge the count when we actually collapsed multiple segments.
  const multi = n > 1;
  const countLabel = multi
    ? isGenerating
      ? `Thinking (${n})`
      : `Thought (${n})`
    : undefined;

  return (
    <div className="my-1" style={{ overflowAnchor: 'none' }}>
      <ThinkingDisclosure
        pending={isGenerating}
        duration={duration}
        elapsed={isGenerating ? elapsed : undefined}
        omitDurationLabel={omitDurationLabel || multi}
        label={countLabel}
      >
        {parts.length > 0 ? (
          <div className="flex flex-col gap-2">
            {parts.map((part, i) => (
              <div
                key={i}
                className="pl-3 border-l border-foreground/15 py-1 thought-content chat-thought-text"
              >
                <Markdown content={part} />
              </div>
            ))}
          </div>
        ) : null}
      </ThinkingDisclosure>
    </div>
  );
}

// ── Tool execution block ──
function _ToolBlock({
  tools,
  toolProgress,
}: {
  tools: NonNullable<ChatMessage['tools']>;
  toolProgress: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
}) {
  return (
    <>
      {tools.map((tool) => (
        <ToolCallItemComp
          key={tool.id}
          tool={tool}
          progress={toolProgress.get(tool.id)}
        />
      ))}
    </>
  );
}

// ----------------------------------------------------
// MessageBubble
// ----------------------------------------------------
export function MessageBubble({
  message,
  isLast,
  streaming,
  sessionId,
  modelId,
  onRevert,
  onEdit,
  onRegenerate,
  onClarifyAnswer,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  sessionId?: string;
  /** Selected model id — used for optional Recap "Rewrite with AI". */
  modelId?: string | null;
  onRevert?: () => void;
  onEdit?: (text: string) => void;
  onRegenerate?: () => void;
  onClarifyAnswer?: (answer: string) => void;
  toolProgress?: Map<string, ReadonlyArray<{ path: string; status: 'reading' | 'read' }>>;
  /** Sub-agent prompt disclosures keyed by the parent toolUse id. Only
   *  present for blocks whose tool name is august__spawn_subagent or
   *  august__run_team (and the team-run agents they spawn). The bubble
   *  renders each disclosure directly under its matching tool call. */
  subagentPrompts?: Map<string, {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }>;
  /** Live sub-agent containers keyed by jobId. Each container has the
   *  sub-agent's own blocks (thinking/text/toolCall/toolResult) and is
   *  rendered as a nested block under the matching parent toolCall.
   *  Independent of `subagentPrompts` so it survives tab switches and
   *  backend reconnects. */
  subagentBlocks?: Map<string, import('./chat-stream-manager').SubagentBlockState>;
}) {
  const [showActions, setShowActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [showRaw, setShowRaw] = useState(false);
  const [userMsgExpanded, setUserMsgExpanded] = useState(false);

  // Hooks must run on every render path, so compute these BEFORE the early
  // returns below (rules-of-hooks).
  const isUser = message.role === 'user';
  const displayBlocks = useMemo(() => {
    if (isUser) return [];
    return getDisplayBlocks(message.blocks, message.thinking, message.tools, message.content);
  }, [message.blocks, message.thinking, message.tools, message.content, isUser]);
  const showPendingThinking = !isUser && isLast && streaming && !showRaw && displayBlocks.length === 0;

  const startEdit = () => {
    setEditText(message.content);
    setEditing(true);
  };

  const saveEdit = () => {
    if (editText.trim() && onEdit) onEdit(editText);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditText('');
  };

  if (message.role === 'tool') {
    const toolKey = message.tool?.name ?? 'legacy';
    return (
      <ToolCallCard
        tool={message.tool!}
        timestamp={message.timestamp}
        progress={toolProgress?.get(toolKey)}
      />
    );
  }

  if (message.kind === 'help') {
    return (
      <div className="flex justify-start">
        <CommandHelpCard />
      </div>
    );
  }

  if (message.kind === 'voice-command-card' && message.commandId) {
    const cmd = voiceCommandRegistry.getById(message.commandId);
    const Card = cmd?.uiCard;
    if (Card) {
      const dismiss = () => {
        // Bubble unmount: parent will re-render without this message.
        // We can't reach setMessages from here without a callback; the
        // message is removed when the user dismisses it via the card's
        // own UI. If the card doesn't call onDismiss, the message stays.
      };
      const props: VoiceCommandCardProps = {
        sessionId: sessionId ?? '',
        onDismiss: dismiss,
        context: message.context,
      };
      return (
        <div className="flex justify-start" data-command-id={message.commandId}>
          <Card {...props} />
        </div>
      );
    }
    // Card component not found — fall through to a small toast-style hint.
    return (
      <div className="flex justify-start text-xs text-muted-foreground">
        Unknown card: {message.commandId}
      </div>
    );
  }

  if (message.kind === 'subagent-approval') {
    return (
      <div className="flex justify-start">
        <SubagentApprovalInline
          breakdown={message.breakdown ?? []}
          onApprove={() => toast.success('Subagent plan approved')}
          onCancel={() => toast.info('Subagent plan cancelled')}
        />
      </div>
    );
  }

  const handleCopy = async () => {
    const textToCopy = message.content;

    // Try clipboard API first, then fallback to execCommand
    const copyText = async (text: string) => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // Clipboard API failed, try fallback
      }

      // Fallback: use execCommand (deprecated but works in insecure contexts)
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
      } catch {
        return false;
      }
    };

    const success = await copyText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);

    if (!success) {
      console.warn('[ChatThread] Copy failed - clipboard unavailable');
    }
  };

  const handleRegenClick = () => {
    if (onRegenerate) {
      setIsRegenerating(true);
      try {
        onRegenerate();
      } finally {
        setIsRegenerating(false);
      }
    }
  };

  const handleSpeak = () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const text = message.content;
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  return (
    <div
      id={`msg-${message.id}`}
      className="w-full flex flex-col"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {!isUser && message.clarify && !message.clarify.answer && onClarifyAnswer && (
        <ClarifyTool
          payload={message.clarify}
          onSubmit={onClarifyAnswer}
        />
      )}
      {/* todos are rendered in the layout-level Workbench sidebar */}
	      {isUser ? (
	        <>
	          <div className="group rounded-xl border border-border/60 bg-card px-3.5 py-2 max-w-[80%] ml-auto shadow-xs hover:border-border/90 hover:shadow-soft transition-[border-color,box-shadow] duration-150">
	            {/* Mid-response queued messages get a small "Queued" badge
	                so the conversation flow makes it clear that the
	                message arrived while the model was already working
	                and was injected without interrupting. */}
	            {message.queued && (
	              <div className="flex items-center gap-1 mb-1 text-[10px] uppercase tracking-wider text-warning font-semibold">
	                <span className="size-1.5 rounded-full bg-warning" />
	                Queued
	              </div>
	            )}
	            {editing ? (
	              <div className="flex flex-col gap-2">
	                <textarea
	                  value={editText}
	                  onChange={(e) => setEditText(e.target.value)}
	                  className="w-full resize-none bg-transparent text-sm outline-none text-foreground"
	                  rows={3}
	                  autoFocus
	                />
	                <div className="flex items-center gap-1.5 justify-end">
	                  <button onClick={cancelEdit} className="px-2.5 py-0.5 text-[11px] rounded-md hover:bg-muted text-muted-foreground transition">Cancel</button>
	                  <button onClick={saveEdit} className="px-2.5 py-0.5 text-[11px] rounded-md bg-primary text-primary-foreground hover:opacity-90 transition">Save</button>
	                </div>
	              </div>
            ) : (
              <div className={cn(
                "relative",
                !userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && "max-h-[160px] overflow-hidden"
              )}>
                {message.attachments && message.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {message.attachments.map((a, i) => {
                      const fi = getFileIcon(a.name);
                      const IconComp = fi.Icon;
                      return (
                        <div key={i} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted/60 border border-border/40 text-[10px] font-mono">
                          <IconComp size={11} color={fi.color} />
                          <span className="truncate max-w-[130px]">{a.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <Markdown content={message.content} />
		                {!userMsgExpanded && message.content.length > LONG_MSG_THRESHOLD && (
		                  <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent pointer-events-none" />
		                )}
	              </div>
              )}
		          </div>
	          <div
	            className={cn(
	              "flex items-center gap-1 mt-1 mr-1 transition-opacity duration-150 self-end",
	              showActions ? "opacity-100" : "opacity-0"
	            )}
	          >
		            {message.content.length > LONG_MSG_THRESHOLD && !editing && (
		              <button
		                type="button"
		                onClick={() => setUserMsgExpanded(!userMsgExpanded)}
		                className="text-[11px] font-semibold uppercase tracking-caps text-primary hover:underline mr-1"
		              >
		                {userMsgExpanded ? 'Show less' : 'Show more'}
		              </button>
		            )}
		            {!editing && message.timestamp && (
		              <span className="bubble-footer-text text-muted-foreground/50 font-medium mr-0.5">
		                {formatClockTime(message.timestamp)}
		              </span>
		            )}
		            {!editing && (
		              <button
		                onClick={() => { void handleCopy(); }}
		                className="p-1 rounded text-muted-foreground/70 hover:text-foreground transition-colors duration-150"
		                title="Copy message"
		                aria-label="Copy message"
		              >
		                {copied ? (
		                  <Check className="size-3 text-success" />
		                ) : (
		                  <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
		                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
		                  </svg>
		                )}
		              </button>
		            )}
		            <button
	              onClick={startEdit}
	              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
	              title="Edit message"
	            >
	              <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
	                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>
	              </svg>
	            </button>
	            <button
	              onClick={onRevert}
	              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition font-mono text-[11px] leading-none"
	              title="Revert changes after this message"
	            >
	              &larr;
	            </button>
		            {isLast && (
		              <button
		                onClick={() => { void handleRegenClick(); }}
		                disabled={streaming || isRegenerating}
		                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-50"
		                title="Regenerate response"
		              >
		                <svg
		                  className={cn("size-3", isRegenerating && "animate-spin")}
		                  viewBox="0 0 24 24"
	                  fill="none"
	                  stroke="currentColor"
	                  strokeWidth="2"
	                  strokeLinecap="round"
	                  strokeLinejoin="round"
	                >
	                  <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
	                </svg>
	              </button>
	            )}
	          </div>
	        </>
      ) : (
        <>
          <div className="flex flex-col w-full gap-2">
            {showRaw ? (
              <div className="p-3 bg-muted/40 rounded-xl border border-border/50 text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto leading-relaxed">
                {JSON.stringify(message, null, 2)}
              </div>
            ) : (
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
                  // Pre-process blocks:
                  //  - consecutive toolCall/command → tool_group (one ToolSummary)
                  //  - consecutive thinking → thinking_group (one "Thinking (N)" disclosure)
                  // After final output exists, ALL pre-final activity collapses into
                  // one ActivitySummary (Thought N · Tools N · …); expand shows the
                  // normal timeline of thoughts + tools.
                  type ToolEntry = typeof displayBlocks[number] & { tool: NonNullable<typeof displayBlocks[number]['tool']> };
                  type ThinkingEntry = { block: typeof displayBlocks[number]; index: number };
                  type RenderUnit =
                    | { kind: 'single'; block: typeof displayBlocks[number]; index: number }
                    | { kind: 'tool_group'; entries: Array<{ block: ToolEntry; index: number }> }
                    | { kind: 'thinking_group'; entries: ThinkingEntry[] };

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
                            isGenerating={isLast && streaming && index === displayBlocks.length - 1}
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
            )}
            {!isUser && (() => {
              const cf = message.changedFiles as { files?: unknown[] } | undefined;
              return cf && Array.isArray(cf.files) && cf.files.length > 0
                ? <ChangedFilesCard changes={message.changedFiles as GitDiffResult} />
                : null;
            })()}
            {/* End-of-turn recap: instant template from tools/files; AI rewrite optional.
                Hide while this message is still streaming so it appears with the settled answer. */}
            {!isUser && !(isLast && streaming) && (
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
              onClick={handleSpeak}
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
              onClick={() => { void handleCopy(); }}
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
                onClick={() => { void handleRegenClick(); }}
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
      )}
    </div>
  );
}

/**
 * Inline sub-agent approval card. Phase 3 will replace this with the full
 * SubagentApprovalCard once the orchestrator's `propose-breakdown` endpoint
 * is wired. For now this is a no-op stub that surfaces the breakdown items.
 */
function SubagentApprovalInline({
  breakdown,
  onApprove,
  onCancel,
}: {
  breakdown: Array<{ goal: string; restrictedTools?: string[] }>;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      data-slot="subagent-approval-inline"
      className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-2xl"
    >
      <div className="text-sm font-semibold text-foreground">
        Subagent plan ({breakdown.length} item{breakdown.length === 1 ? '' : 's'})
      </div>
      {breakdown.length === 0 ? (
        <div className="text-xs text-muted-foreground">No items proposed.</div>
      ) : (
        <ul className="space-y-2">
          {breakdown.map((item, idx) => (
            <li key={idx} className="text-xs space-y-0.5">
              <div className="text-foreground/90">{item.goal}</div>
              {item.restrictedTools && item.restrictedTools.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Tools: {item.restrictedTools.join(', ')}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onApprove}
          className="px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 rounded-md border border-border text-xs font-medium hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ToolCallCard({
  tool,
  timestamp: _timestamp,
  progress,
}: {
  tool: NonNullable<ChatMessage['tool']>;
  timestamp: string;
  progress?: ReadonlyArray<{ path: string; status: 'reading' | 'read' }>;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = !!(tool.args || tool.result);
  const toolNameForIcon = tool.name.replace(/^@/, '');
  const isCommand = toolNameForIcon === 'run_command' || tool.name.startsWith('@run_command');
  // Try to extract a filename hint from the args JSON for a brand-aware file icon.
  let legacyFilename: string | null = null;
  if (!isCommand && tool.args) {
    try {
      const parsed = JSON.parse(tool.args) as Record<string, unknown>;
      for (const key of ['filePath', 'file_path', 'path', 'filename', 'file', 'filepath']) {
        const v = parsed?.[key];
        if (typeof v === 'string' && v.length > 0) { legacyFilename = v; break; }
      }
    } catch { /* not JSON — ignore */ }
  }
  return (
    <div className="text-sm text-muted-foreground w-full py-0.5" data-slot="tool-block">
      <DisclosureRow
        onToggle={hasBody ? () => setOpen(!open) : undefined}
        open={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {legacyFilename ? (
            <NewFileIcon name={legacyFilename} size={14} className="shrink-0" />
          ) : (
            <NewToolIcon name={toolNameForIcon} kind={isCommand ? 'command' : 'tool'} size={14} className="shrink-0" />
          )}
          <span
            className={cn(
              'text-sm font-medium leading-5',
              tool.status === 'running' && 'shimmer text-foreground/55'
            )}
          >
            <span className={cn('thinking-text', tool.status === 'running' && 'animating')}>
              <span className="thinking-label">
                {Array.from(getToolLabel(tool.name)).map((ch, i) => (
                  <span
                    key={i}
                    className={cn('thinking-char', i === 0 && 'thinking-cap')}
                    style={{ animationDelay: `${i * 100}ms` }}
                  >
                    {ch}
                  </span>
                ))}
              </span>
              {tool.status === 'running' && (
                <span className="thinking-dots">
                  <span className="dot" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '200ms' }}>.</span>
                  <span className="dot" style={{ animationDelay: '400ms' }}>.</span>
                </span>
              )}
            </span>
          </span>
          {tool.status === 'done' && <span className="text-primary/80 text-[12px]">done</span>}
          {tool.status === 'error' && <span className="text-destructive text-[12px]">error</span>}
        </span>
      </DisclosureRow>
      {(() => {
        const visible = progress ? visibleProgress(progress) : [];
        const total = progress?.length ?? 0;
        const overflow = Math.max(0, total - visible.length);
        if (visible.length === 0) return null;
        return (
          <div className="ml-3 mt-0.5 mb-1 space-y-0.5 border-l border-border/30 pl-2" aria-label="Tool progress" data-tool-progress>
            {visible.map((entry) => (
              <div key={entry.path} className="flex items-center gap-1.5 text-[11.5px] truncate" title={entry.path}>
                <span className="w-2.5 shrink-0 inline-flex justify-center">
                  {entry.status === 'reading' ? (
                    <Loader2 size={10} className="animate-spin text-info" />
                  ) : (
                    <Check size={10} className="text-muted-foreground/50" />
                  )}
                </span>
                <span
                  className={cn(
                    'truncate font-mono',
                    entry.status === 'reading' ? 'text-info italic' : 'text-muted-foreground/60 line-through'
                  )}
                >
                  {entry.status === 'reading' ? 'Reading ' : 'Read '}
                  {entry.path}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="text-[10px] text-muted-foreground/50 italic pl-4">+ {overflow} more</div>
            )}
          </div>
        );
      })()}
      {open && hasBody && (
        <div className="mt-0.5 w-full min-w-0 max-w-full overflow-hidden wrap-anywhere pb-1">
          {tool.args && (
            <pre className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-muted-foreground/70 break-words leading-relaxed border-l border-border/30 ml-2.5">
              {tool.args}
            </pre>
          )}
          {tool.result && (
            <div className="px-2 py-1.5 font-mono whitespace-pre-wrap text-[13px] text-foreground/80 break-words leading-relaxed border-l border-border/30 ml-2.5">
              {tool.result}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

