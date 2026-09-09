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
  showActions,
  copied,
  speaking,
  isRegenerating,
  toolProgress,
  subagentPrompts,
  subagentBlocks,
  subagentRoster,
  onSpeak,
  onCopy,
  onRegen,
  onFork,
  onReanswer,
  reanswerOpen,
  onCompare,
  onDismissError,
}: {
  message: ChatMessage;
  isLast?: boolean;
  streaming?: boolean;
  modelId?: string | null;
  /** Owning session id — Undo target for the ChangesCard. */
  sessionId?: string | null;
  displayBlocks: DisplayBlock[];
  showPendingThinking: boolean;
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  isRegenerating: boolean;
  toolProgress?: ToolProgressMap;
  subagentPrompts?: Map<string, SubagentPromptEntry>;
  subagentBlocks?: Map<string, SubagentBlockState>;
  subagentRoster?: ReadonlyArray<{
    jobId: string;
    agentId: string;
    task: string;
    status: 'running' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'partial' | 'done' | 'error';
    startedAt?: number;
    finishedAt?: number;
    workstream?: string;
  }>;
  onSpeak: () => void;
  onCopy: () => void;
  onRegen: () => void;
  onFork?: () => void;
  /** "Answer this with another model" — toggles the model list in the bubble. */
  onReanswer?: () => void;
  reanswerOpen?: boolean;
  /** "Compare" — re-run this prompt on 2–3 models side by side. */
  onCompare?: () => void;
  /** Dismiss the provider-error bubble (removes the error block). */
  onDismissError?: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-col w-full gap-2">
        <AssistantBlockTimeline
          displayBlocks={displayBlocks}
          message={message}
          isLast={isLast}
          streaming={streaming}
          showPendingThinking={showPendingThinking}
          toolProgress={toolProgress}
          subagentPrompts={subagentPrompts}
          subagentBlocks={subagentBlocks}
          subagentRoster={subagentRoster}
          modelId={modelId}
          sessionId={sessionId}
          onRetryTurn={onRegen}
          onSwitchModel={onReanswer}
          onDismissError={onDismissError}
        />
        {/* Unified ZCode-style changes card (plan §4.5): aggregate
            `X files changed +N −M [Undo]` header with type-aware per-file
            rows. Deferred until the turn finishes — mid-stream the totals
            are unsettled and the card reads as premature noise (same gate
            CircuitArtifactCard uses below). */}
        {!(isLast && streaming) && (
          <ChangesCard
            blocks={message.blocks}
            changedFiles={message.changedFiles as GitDiffResult | null}
            sessionId={sessionId}
          />
        )}
        {/* Claude-style circuit deliverable cards: one compact clickable chip
            per schematic/3D/netlist/simulation output; content opens in the
            right side panel, never inline in chat. */}
        {!(isLast && streaming) && (
          <CircuitArtifactCard blocks={message.blocks} />
        )}
        {/* End-of-turn recap card removed by user request (2026-08-25):
            the chat area stays clean — activity lives in the right panel. */}
        {/* Generation rate — ONLY once the turn completes, from the real
            usage numbers (output tokens / model generation time). The old
            live "~N t/s" estimate was removed (2026-09-08): the smooth
            character reveal is the in-flight feedback now. */}
        {isLast && !streaming && message.usage && message.usage.outputTokens > 0 && message.usage.durationMs && message.usage.durationMs > 0 ? (
          <div
            className="text-[10px] tabular-nums text-muted-foreground/60"
            title={`${message.usage.outputTokens.toLocaleString()} output tokens in ${(message.usage.durationMs / 1000).toFixed(1)}s of model generation`}
            data-testid="final-rate-chip"
          >
            {(message.usage.outputTokens / (message.usage.durationMs / 1000)).toFixed(1)} t/s
          </div>
        ) : null}
        {/* Transient provider-retry notice (429/5xx backoff) — replaced on
            each attempt, cleared when the turn finalizes. The dots animate
            (travel) rather than the whole line fading. */}
        {message.retryNotice && (
          <div className="flex items-center gap-1 text-[11px] text-warning/90" data-testid="retry-notice">
            <span>Reconnecting</span>
            <span className="inline-flex items-center gap-0.5" aria-hidden>
              <span className="reconnect-dot size-1 rounded-full bg-current" style={{ animationDelay: '0ms' }} />
              <span className="reconnect-dot size-1 rounded-full bg-current" style={{ animationDelay: '180ms' }} />
              <span className="reconnect-dot size-1 rounded-full bg-current" style={{ animationDelay: '360ms' }} />
            </span>
            <span className="tabular-nums">{message.retryNotice.replace(/^Reconnecting\s*/, '')}</span>
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
      </div>
      <AssistantMessageActions
        showActions={showActions}
        copied={copied}
        speaking={speaking}
        isLast={isLast}
        streaming={streaming}
        isRegenerating={isRegenerating}
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
