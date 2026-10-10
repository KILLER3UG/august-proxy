import { ChangesCard } from '@/components/chat/ChangesCard';
import { CircuitArtifactCard } from '@/components/chat/CircuitArtifactCard';
import { TurnProvenanceChip } from '@/components/chat/TurnProvenanceChip';
import { SavePointChip } from '@/components/chat/SavePointChip';
import { SkillReceiptChip } from '@/components/chat/SkillReceiptChip';
import type { WorkbenchCheckpoint } from '@/api/workbench';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import {
  AssistantBlockTimeline,
  type SubagentPromptEntry,
  type ToolProgressMap,
} from './AssistantBlockTimeline';
import { Clock } from 'lucide-react';
import { AssistantMessageActions } from './AssistantMessageActions';
import { TurnEndActionRow } from './TurnEndActionRow';
import { turnEndActions, turnEndPhrase, turnEndRemedy } from '@/lib/turn-end';

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
  savePoints,
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
  onContinue,
  onEditPrompt,
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
  /** File save points taken during this turn — rendered as SavePointChip. */
  savePoints?: WorkbenchCheckpoint[];
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
  /** Turn-end "Continue" — resume a stopped turn from where it broke. */
  onContinue?: () => void;
  /** Turn-end "Edit prompt" — open the originating user message for editing. */
  onEditPrompt?: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-col w-full gap-2">
        {message.queued && !streaming ? (
          // Backend accepted the message into the queue — a structural
          // notice, not model prose (the QueuePills row above the composer
          // carries the same state).
          <div
            className="flex items-start gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-2xs text-muted-foreground"
            role="status"
            data-testid="queued-notice"
          >
            <Clock className="mt-0.5 size-3 shrink-0 text-info" aria-hidden />
            <span>Queued — this runs when the current response finishes.</span>
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
          subagentRoster={subagentRoster}
          modelId={modelId}
          sessionId={sessionId}
          onRetryTurn={onRegen}
          onSwitchModel={onReanswer}
          onDismissError={onDismissError}
        />
        )}
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
          <CircuitArtifactCard tools={message.tools} />
        )}
        {/* End-of-turn recap card removed by user request (2026-08-25):
            the chat area stays clean — activity lives in the right panel. */}
        {/* Generation rate — ONLY once the turn completes, from the real
            usage numbers (output tokens / model generation time). The old
            live "~N t/s" estimate was removed (2026-09-08): the smooth
            character reveal is the in-flight feedback now. */}
        {isLast && !streaming && message.usage && message.usage.outputTokens > 0 && message.usage.durationMs && message.usage.durationMs > 0 ? (
          <div
            className="text-2xs tabular-nums text-tier-2"
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
          <div className="flex items-center gap-1 text-2xs text-warning/90" data-testid="retry-notice">
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
            className="text-2xs text-muted-foreground/60"
            title="The primary model failed; this model answered the turn"
            data-testid="fallback-chip"
          >
            answered via {message.usedFallback}
          </div>
        ) : null}
        {/* Truncated answer (audit P0#6): turn_end reason `length` means the
            model hit the output cap with its continuation budget spent — the
            text above LOOKS complete but isn't. The recovery event log
            carries the attempt detail (recovery{kind, attempt, degraded}). */}
        {!(isLast && streaming) && message.turnEnd?.reason === 'length' ? (
          <div className="text-2xs text-warning/90" data-testid="truncated-answer-note">
            cut off at the output limit — the answer above is incomplete
          </div>
        ) : null}
        {/* turn_end badge: why the tool loop stopped + round count. A clean
            `finished` stop stays quiet (the rate chip already caps that
            turn); anything else — stalled, cap, error, interrupted — shows
            in amber with the raw token + round count in the tooltip. */}
        {!(isLast && streaming) &&
          message.turnEnd &&
          message.turnEnd.reason !== 'finished' ? (
          <div
            className={`text-2xs ${
              message.turnEnd.error
                ? 'text-danger-fg'
                : 'text-warning/90'
            }`}
            data-testid="turn-end-badge"
          >
            {/* Visible + keyboard-reachable, not a `title` tooltip: a stop
                reason the user cannot act on is decoration. The raw token
                stays available for the event log / turn_outcomes column. */}
            <details className="group">
              <summary className="cursor-pointer list-none marker:content-none">
                {message.turnEnd.reason
                  ? turnEndPhrase(message.turnEnd.reason)
                  : 'stopped'}
                {typeof message.turnEnd.rounds === 'number'
                  ? ` · ${message.turnEnd.rounds} round${message.turnEnd.rounds === 1 ? '' : 's'}`
                  : ''}
                <span className="ml-1 opacity-60 group-open:hidden">
                  · why?
                </span>
              </summary>
              <div className="mt-1 space-y-0.5">
                {turnEndRemedy(message.turnEnd.reason ?? '') ? (
                  <div data-testid="turn-end-remedy">
                    {turnEndRemedy(message.turnEnd.reason ?? '')}
                  </div>
                ) : null}
                <div className="opacity-60">
                  turn_end: {message.turnEnd.reason ?? 'no reason recorded'}
                </div>
                {/* Recovery controls, hung off the notice itself rather than
                    making the reader scroll to the composer. Both reference
                    UIs do this, and a turn that stopped is the one moment the
                    user most wants a one-click path back in.

                    `error`-flavoured stops whose message already renders an
                    error block get NOTHING here: the provider bubble owns
                    retry + switch-model, and a second retry control on the
                    same message reads as a bug. The check is on the rendered
                    block, not the reason string, because `turn_end.error` is
                    broader than `reason === 'error'`. */}
                <TurnEndActionRow
                  actions={turnEndActions(
                    message.turnEnd.reason,
                    (message.blocks ?? []).some((b) => b.type === 'error'),
                  )}
                  streaming={streaming}
                  onContinue={onContinue}
                  onRetry={onRegen}
                  onEditPrompt={onEditPrompt}
                />
              </div>
            </details>
          </div>
        ) : null}
        {/* Audit A6: the skills and facts that went into THIS answer, plus the
            failure families the loop hit — the provenance chip. Rendered
            last so it reads as the footnote to everything above it, and
            gated on the same `!(isLast && streaming)` as its siblings: the
            frame that carries it is emitted at turn close, never mid-stream. */}
        {!(isLast && streaming) && <TurnProvenanceChip provenance={message.provenance} />}
        {/* SavePointChip + SkillReceiptChip join the provenance row; both hide
            mid-stream on the same gate (nothing to say about a turn that is
            still running). SkillReceiptChip is the turn's own skill write — the
            autonomy notice is SkillEvolvedChip, above the composer. */}
        {!(isLast && streaming) && (
          <SavePointChip checkpoints={savePoints ?? []} sessionId={sessionId} />
        )}
        {!(isLast && streaming) && <SkillReceiptChip tools={message.tools} />}
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
