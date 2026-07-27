import { useEffect, useState } from 'react';
import { RecapCard } from '@/components/chat/RecapCard';
import { ChangedFilesCard } from '@/components/chat/ChangedFilesCard';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import {
  AssistantBlockTimeline,
  type SubagentPromptEntry,
  type ToolProgressMap,
} from './AssistantBlockTimeline';
import { AssistantMessageActions } from './AssistantMessageActions';
import { formatTokenCount, formatTokensPerSecond } from './token-display';

type DisplayBlock = MessageBlock;

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
  onFork,
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
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onFork?: () => void;
}) {
  const tokensPerSecond = message.usage ? formatTokensPerSecond(message.usage) : null;

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
        {/* Per-turn token usage chip (from the `done` SSE event). */}
        {!(isLast && streaming) &&
          message.usage &&
          (message.usage.inputTokens > 0 || message.usage.outputTokens > 0) && (
            <div
              className="text-[10px] tabular-nums text-muted-foreground/60"
              title={`Input ${message.usage.inputTokens.toLocaleString()} tokens · Output ${message.usage.outputTokens.toLocaleString()} tokens${
                message.usage.contextTokens
                  ? ` · Context ${message.usage.contextTokens.toLocaleString()} tokens`
                  : ''
              }${
                message.usage.durationMs
                  ? ` · Generated in ${(message.usage.durationMs / 1000).toFixed(1)}s`
                  : ''
              }`}
            >
              ↑{formatTokenCount(message.usage.inputTokens)} · ↓
              {formatTokenCount(message.usage.outputTokens)}
              {tokensPerSecond && ` · ${tokensPerSecond} t/s`}
              {message.usage.contextTokens > 0 &&
                ` · ctx ${formatTokenCount(message.usage.contextTokens)}`}
            </div>
          )}
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
      />
    </>
  );
}
