import { useEffect, useState } from 'react';
import { ChangesCard } from '@/components/chat/ChangesCard';
import { CircuitArtifactCard } from '@/components/chat/CircuitArtifactCard';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import {
  AssistantBlockTimeline,
  type SubagentPromptEntry,
  type ToolProgressMap,
} from './AssistantBlockTimeline';
import { AssistantMessageActions } from './AssistantMessageActions';
import { formatTokenCount, formatTurnDuration } from './token-display';

type DisplayBlock = MessageBlock;

/** Assistant message body: blocks timeline, recap, and action footer. */
export function AssistantMessageContent({
  message,
  isLast,
  streaming,
  modelId,
  sessionId,
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
  onFork,
  onReanswer,
  reanswerOpen,
  onCompare,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  modelId?: string | null;
  /** Owning session id — Undo target for the ChangesCard. */
  sessionId?: string | null;
  displayBlocks: DisplayBlock[];
  showPendingThinking: boolean;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isRegenerating: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onFork?: () => void;
  /** "Answer this with another model" — toggles the model list in the bubble. */
  onReanswer?: () => void;
  reanswerOpen?: boolean;
  /** "Compare" — re-run this prompt on 2–3 models side by side. */
  onCompare?: () => void;
}) {
  // Live generation-rate estimate while the last message streams: output
  // tokens ≈ chars/4 over elapsed time (same heuristic ChatThread blends).
  // Replaced by the real chip once the `done` event lands usage+durationMs.
  const isStreamingThis = Boolean(isLast && streaming);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isStreamingThis) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStreamingThis]);
  let liveRate: string | null = null;
  if (isStreamingThis) {
    const startMs = Date.parse(message.timestamp);
    const elapsedS = Math.max(1, (now - startMs) / 1000);
    const chars = (message.content || '').length;
    if (Number.isFinite(startMs) && chars >= 20) {
      const rate = chars / 4 / elapsedS;
      if (Number.isFinite(rate) && rate > 0) {
        liveRate = rate >= 100 ? String(Math.round(rate)) : (Math.round(rate * 10) / 10).toString();
      }
    }
  }

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
            modelId={modelId}
            sessionId={sessionId}
            onRetryTurn={onRegen}
            onSwitchModel={onReanswer}
          />
        )}
        {/* Unified ZCode-style changes card (plan §4.5): aggregate
            `X files changed +N −M [Undo]` header with type-aware per-file
            rows. Visible as soon as the first edit block lands — files
            arrive in real time; totals settle when the git diff lands. */}
        <ChangesCard
          blocks={message.blocks}
          changedFiles={message.changedFiles as GitDiffResult | null}
          sessionId={sessionId}
        />
        {/* Claude-style circuit deliverable cards: one compact clickable chip
            per schematic/3D/netlist/simulation output; content opens in the
            right side panel, never inline in chat. */}
        {!(isLast && streaming) && (
          <CircuitArtifactCard blocks={message.blocks} />
        )}
        {/* End-of-turn recap card removed by user request (2026-08-25):
            the chat area stays clean — activity lives in the right panel. */}
        {/* Live generation-rate estimate while streaming (tilde = estimate). */}
        {isStreamingThis && liveRate && (
          <div
            className="text-[10px] tabular-nums text-muted-foreground/60"
            title="Estimated live generation rate (final rate shows when the turn completes)"
            data-testid="live-rate-chip"
          >
            ~{liveRate} t/s
          </div>
        )}
        {/* Transient provider-retry notice (429/5xx backoff) — replaced on
            each attempt, cleared when the turn finalizes. */}
        {message.retryNotice && (
          <div className="text-[11px] text-warning/90 animate-pulse" data-testid="retry-notice">
            {message.retryNotice}
          </div>
        )}
        {/* Fallback chip (D8): a chain/promotion switch answered this turn. */}
        {!(isLast && streaming) && message.usedFallback ? (
          <div
            className="text-[10px] text-muted-foreground/60"
            title="The primary model failed; this model answered the turn"
            data-testid="fallback-chip"
          >
            answered via {message.usedFallback}
          </div>
        ) : null}
        {/* Per-turn stats footer: billed tokens + generation time (from the
            done payload). Hidden while streaming so it appears settled. */}
        {!(isLast && streaming) &&
        message.usage &&
        (message.usage.inputTokens > 0 || message.usage.outputTokens > 0) ? (
          <div
            className="text-[10px] tabular-nums text-muted-foreground/50"
            data-testid="turn-stats-footer"
          >
            {formatTokenCount(message.usage.inputTokens)} in ·{' '}
            {formatTokenCount(message.usage.outputTokens)} out
            {message.usage.durationMs ? ` · ${formatTurnDuration(message.usage.durationMs)}` : ''}
          </div>
        ) : null}
      </div>
      <AssistantMessageActions
        showActions={showActions}
        copied={copied}
        speaking={speaking}
        isLast={isLast}
        streaming={streaming}
        isRegenerating={isRegenerating}
        showRaw={showRaw}
        setShowRaw={setShowRaw}
        onSpeak={onSpeak}
        onCopy={onCopy}
        onRegen={onRegen}
        onFork={onFork}
        onReanswer={onReanswer}
        reanswerOpen={reanswerOpen}
        onCompare={onCompare}
      />
    </>
  );
}
