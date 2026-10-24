import { ChangesCard } from '@/components/chat/ChangesCard';
import { ArtifactCards } from '@/components/chat/ArtifactCard';
import { CircuitArtifactCard } from '@/components/chat/CircuitArtifactCard';
import { TurnProvenanceChip } from '@/components/chat/TurnProvenanceChip';
import { SavePointChip } from '@/components/chat/SavePointChip';
import { SkillReceiptChip } from '@/components/chat/SkillReceiptChip';
import { MemorySaveChip } from '@/components/chat/MemorySaveChip';
import type { WorkbenchCheckpoint } from '@/api/workbench';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';
import type { SubagentBlockState } from '../chat-stream-manager';
import {
  AssistantBlockTimeline,
  type SubagentPromptEntry,
  type ToolProgressMap,
} from './AssistantBlockTimeline';
import { ChevronDown, Clock } from 'lucide-react';
import { Task, TaskContent, TaskTrigger } from '@/components/ui/task';
import { Button } from '@/components/ui/button';
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
            tools={message.tools}
            changedFiles={message.changedFiles as GitDiffResult | null}
            sessionId={sessionId}
          />
        )}
        {/* The reference's artifact card: a file this turn produced, as one
            compact card, opening its content in the side panel — never
            inline in the chat.

            The circuit deliverables sit in the SAME list, under their own
            label: one list of artifacts per turn, instead of two groups
            with the changes card between them. (They were mounted in
            different components, so a turn that produced both read as
            answer → general artifacts → changes card → circuit artifacts.)

            The changes card keeps its place above them — it is the turn's
            diff summary, and it is not an artifact. */}
        {!(isLast && streaming) && (
          <>
            <ArtifactCards
              blocks={message.blocks}
              tools={message.tools}
              sessionId={sessionId}
            />
            <CircuitArtifactCard tools={message.tools} />
          </>
        )}
        {/* End-of-turn recap card removed by user request (2026-08-25):
            the chat area stays clean — activity lives in the right panel. */}
        {/* The per-turn generation-rate readout ("12.4 t/s") is GONE, and the
            comment that described it went with it.

            It was never the live estimate the old comment talked about. The
            live "~N t/s" chip was dropped and the FINAL rate — real usage
            numbers, once the turn closed — took its place in ONE change (the
            transcript-parity batch of 2026-09-09, which the comment itself
            dated 2026-09-08). So the comment was accurate about the block it
            sat on and misleading about the surface: it read as if no rate
            were rendered while one was.

            Nothing reads it (`final-rate-chip` had no consumer), a rate is a
            metric and not a state a reader can act on, and the reference
            transcript carries no per-turn rate at all. The turn's numbers are
            not lost with it: the Runs page's muted `tokens · cost ·
            duration` meta line, the Usage stats dashboard, and the composer's
            cost chip all still carry them. */}
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
        {/* Fallback (D8): a chain/promotion switch answered this turn.

            KEPT through the reference-density pass, deliberately: this is the
            ONLY place in the app that says which model actually answered.
            The backend sets it on purpose (`doneEvent['usedFallback']` — "the
            message shows who actually answered when a fallback/promotion
            switch happened mid-turn") and the field is persisted per message,
            so it survives a reload; deleting the line would hide a recorded
            fact rather than a decoration.

            It stays a quiet note, not a chip: tier-2 muted text, one line, no
            border — the same vocabulary the reference gives metadata. */}
        {!(isLast && streaming) && message.usedFallback ? (
          <div
            className="text-2xs text-tier-2"
            title="The primary model failed; this model answered the turn"
            data-testid="fallback-chip"
          >
            answered via {message.usedFallback}
          </div>
        ) : null}
        {/* Truncated answer (audit P0#6): turn_end reason `length` means the
            model hit the output cap with its continuation budget spent — the
            text above LOOKS complete but isn't. The recovery event log
            carries the attempt detail (recovery{kind, attempt, degraded}).

            The notice names BOTH halves of the contract the user actually
            has. It used to stop at "the answer above is incomplete", which
            says what went wrong and nothing about what to do: the backend's
            continuation budget is already spent, and "continue" is the word
            that resumes the model on the next turn. Nothing is lost — the
            partial answer stays in the conversation. */}
        {!(isLast && streaming) && message.turnEnd?.reason === 'length' ? (
          <div className="text-2xs text-warning/90" data-testid="truncated-answer-note">
            cut off at the output limit — the answer above is incomplete, and
            everything it did say stays in the conversation. Send
            &ldquo;continue&rdquo; to let the model pick up where it stopped.
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
            {/* Converged on the transcript's Task disclosure (B4's "one
                component"): this was the last inline <details> in the message
                body. Visible + keyboard-reachable, not a `title` tooltip: a
                stop reason the user cannot act on is decoration. The raw token
                stays in the expanded body for the event log / turn_outcomes
                column, and the chevron is the shared `.disclosure-chevron`
                marker rotating on Radix's own data-state. */}
            <Task defaultOpen={false} className="inline-block">
              <TaskTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1 px-1 py-0 text-left text-2xs"
                >
                  {message.turnEnd.reason
                    ? turnEndPhrase(message.turnEnd.reason)
                    : 'stopped'}
                  {typeof message.turnEnd.rounds === 'number'
                    ? ` · ${message.turnEnd.rounds} round${message.turnEnd.rounds === 1 ? '' : 's'}`
                    : ''}
                  <span className="ml-1 opacity-60 group-data-[state=open]:hidden">
                    · why?
                  </span>
                  <ChevronDown className="disclosure-chevron" aria-hidden />
                </Button>
              </TaskTrigger>
              <TaskContent className="mt-1">
                <div className="space-y-0.5">
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
              </TaskContent>
            </Task>
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
        {!(isLast && streaming) && <MemorySaveChip tools={message.tools} />}
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
        timestamp={!streaming ? message.timestamp : null}
      />
    </>
  );
}
