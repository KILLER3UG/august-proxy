/* ── ChatThreadComposer ───────────────────────────────────────────────── */
/* Floating pill message box: attachments, @skills/tools, /commands,       */
/* model/effort menu, send / mid-run steer, stop.                          */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import type { WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { QueuePills } from './QueuePills';
import { StreamLinkBanner } from './StreamLinkBanner';
import { ArenaLaunchModal } from './composer/ArenaLaunchModal';
import { DebateLaunchModal } from './debate/DebateLaunchModal';
import type { DebateRun } from './debate/debate-store';
import { WifiOff } from 'lucide-react';
import type { QueuedUserMessage } from './queue-store';
import { Markdown } from './ChatMarkdown';
import { TaskProgressPill } from '@/components/chat/TaskProgressPill';
import { ScrollToBottomButton } from '@/components/chat/ScrollToBottomButton';
import type { ModelItem } from './model-display';
import type { SessionUsageState } from './hooks/useChatUsage';
/* `EffortLevel` is back for the footer's muted word after the model name. Only
 * the `setEffort` half of the old model row's props is still gone — the state
 * itself remains in ChatThread and is still sent with every turn. */
import type { EffortLevel } from './hooks/useChatSend';
import { ModelEffortMenu } from './composer/ModelEffortMenu';
import {
  useComposerPopovers,
  type ComposerDropdownApi,
} from './composer/useComposerPopovers';
import { ComposerAttachmentChips } from './composer/ComposerAttachmentChips';
import { ComposerMentionsDropdown } from './composer/ComposerMentionsDropdown';
import { ComposerCommandsDropdown } from './composer/ComposerCommandsDropdown';
import { ComposerToolbar } from './composer/ComposerToolbar';
import { ComposerWorkspaceChips } from './composer/ComposerWorkspaceChips';
import { ComposerVoiceListening } from './composer/ComposerVoiceListening';
import { ContextUsageReadout } from './composer/ContextUsageReadout';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';
import { setContinueWorkstream, useContinueWorkstream } from '@/components/chat/composer-intent';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { continueWorkstream, listWorkstreams, runRoutine, steer as steerSubagent } from '@/api/subagents';
import type { ChatSendFn, ChatSendOptions } from './hooks/useChatSend';

export type { ComposerDropdownApi };

export interface ChatThreadComposerProps {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: FileAttachment[];
  /** True while any attachment is still being read/extracted. */
  attachmentsReading?: boolean;
  /** Count of ready attachments (excludes in-progress / failed). */
  readyAttachmentsCount?: number;
  removeAttachment: (index: number) => void;
  handleComposerPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  /** Push a fresh File (e.g. camera capture) into the attachment pipeline. */
  attachFiles?: (files: FileList | File[]) => Promise<void> | void;
  messages: ChatMessage[];
  streaming: boolean;
  send: ChatSendFn;
  stop: () => void;
  /** Optional: lets the composer toolbar append a synthetic handoff-notice card. */
  /** Creates the backend workbench session on demand (before the first
   *  send on a fresh chat). */
  ensureWorkbenchSession: () => Promise<WorkbenchSession | null>;
  queuedMessages: QueuedUserMessage[];
  workbenchSession: WorkbenchSession | null;
  setWorkbenchSession: (
    session:
      | WorkbenchSession
      | null
      | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
  ) => void;
  workbenchMode: WorkbenchGuardMode;
  setWorkbenchMode: Dispatch<SetStateAction<WorkbenchGuardMode>>;
  workspacePath?: string | null;
  activeWorkbenchSessionId?: string | null;
  /** Context ring inputs */
  sessionUsage: SessionUsageState;
  visibleModels: ModelItem[];
  selectedModel: ModelItem | null;
  /** The muted word after the model name on the footer line. The reference
   *  shows `Sonnet 5.5  High` there — effort in muted, no chip — but it stays
   *  changeable through the effort pane (`onEffortChange`); an earlier round
   *  of the redesign made this read-only and the reference re-read undid it. */
  effort: EffortLevel;
  onSelectModel: (m: ModelItem) => void;
  onEffortChange: (v: EffortLevel) => void;
  /** Opens the Edit Models (visibility) modal in ChatThread. Without it the
   *  model pane's "Manage models" footer never renders and a hidden model
   *  cannot be un-hidden — the hide action would be irreversible. */
  onEditModels?: () => void;
  thinkingEnabled: boolean;
  onThinkingChange: (v: boolean) => void;
  /** Arena ("ask in parallel"): run the prompt on 2–3 models in forks. */
  onArenaLaunch?: (targets: ModelItem[], prompt: string) => void;
  /** Structured debate (A5): two models argue in this chat, optional judge. */
  onDebateLaunch?: (
    a: DebateRun['models'][number],
    b: DebateRun['models'][number],
    judge: DebateRun['models'][number] | null,
    rounds: number,
    prompt: string,
  ) => void;
  /** Offline compose (C9): queued messages waiting for the backend. */
  offlineCount?: number;
  onFlushOffline?: () => void;
  voiceActive: boolean;
  startVoiceInput: () => void;
  stopVoiceInput: () => void;
  /** Jump-to-bottom affordance anchored to the composer card's top border. */
  scrolledFromBottom: boolean;
  showNewContentPill: boolean;
  onScrollToBottom: () => void;
  /** Optional: parent registers send-path popover closers. */
  dropdownApiRef?: MutableRefObject<ComposerDropdownApi | null>;
}

/**
 * Bottom (or empty-state) message composer: textarea, popovers, toolbar.
 */
export function ChatThreadComposer(props: ChatThreadComposerProps) {
  const {
    sessionId,
    loadedSessionId,
    input,
    setInput,
    attachments,
    attachmentsReading = false,
    readyAttachmentsCount,
    removeAttachment,
    handleComposerPaste,
    handleFileUpload,
    attachFiles,
    messages,
    streaming,
    send,
    stop,
    ensureWorkbenchSession,
    queuedMessages,
    workbenchSession,
    setWorkbenchSession,
    workbenchMode,
    setWorkbenchMode,
    workspacePath,
    activeWorkbenchSessionId,
    sessionUsage,
    visibleModels,
    selectedModel,
    effort,
    onSelectModel,
    onEffortChange,
    onEditModels,
    thinkingEnabled,
    onThinkingChange,
    onArenaLaunch,
    onDebateLaunch,
    offlineCount = 0,
    onFlushOffline,
    voiceActive,
    startVoiceInput,
    stopVoiceInput,
    scrolledFromBottom,
    showNewContentPill,
    onScrollToBottom,
    dropdownApiRef,
  } = props;

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusedSubagent = useFocusedSubagent();
  const continueName = useContinueWorkstream();
  const continueHint = useQuery({
    queryKey: ['workstreams', workbenchSession?.id],
    queryFn: () => listWorkstreams(workbenchSession!.id),
    enabled: !!workbenchSession?.id && !!continueName,
  });
  const ghostNext =
    continueHint.data?.find((w) => w.name === continueName)?.latest?.next?.trim() || '';
  const harnessMode = normalizeHarnessMode(workbenchSession?.agentMode);
  const sendKind =
    focusedSubagent ? 'steer' : continueName ? 'continue' : harnessMode === 'orchestrator' ? 'dispatch' : 'send';
  const sendOrSteer = useCallback<ChatSendFn>(
    async (textOverride?: string, options?: ChatSendOptions) => {
      const text = (textOverride ?? input).trim();
      const laneAt = text.match(/^@lane:([^\s]+)\s*([\s\S]*)$/);
      if (laneAt && workbenchSession?.id) {
        try {
          await continueWorkstream(
            workbenchSession.id,
            laneAt[1],
            laneAt[2].trim() || ghostNext || 'Continue from the last episode.',
          );
          toast.success(`Continuing ${laneAt[1]}`);
          setInput('');
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Continue failed');
          return 'skipped';
        }
        return 'sent';
      }
      const routineAt = text.match(/^@routine:([^\s]+)\s*/);
      if (routineAt && workbenchSession?.id) {
        try {
          await runRoutine(workbenchSession.id, routineAt[1]);
          toast.success('Routine running');
          setInput('');
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Routine failed');
          return 'skipped';
        }
        return 'sent';
      }
      if (focusedSubagent && text) {
        const running = focusedSubagent.running !== false;
        try {
          if (running) {
            await steerSubagent(focusedSubagent.jobId, text);
            toast.success(`Steering ${focusedSubagent.title} (next round)`);
          } else if (focusedSubagent.workstream && workbenchSession?.id) {
            await continueWorkstream(workbenchSession.id, focusedSubagent.workstream, text);
            toast.success(`Continuing ${focusedSubagent.workstream}`);
            setContinueWorkstream(null);
          } else {
            await steerSubagent(focusedSubagent.jobId, text);
            toast.success(`Queued for ${focusedSubagent.title}`);
          }
          setInput('');
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Steer failed';
          if (focusedSubagent.workstream && workbenchSession?.id) {
            try {
              await continueWorkstream(workbenchSession.id, focusedSubagent.workstream, text);
              toast.success(`Worker idle — continued ${focusedSubagent.workstream}`);
              setInput('');
              setContinueWorkstream(null);
              return 'sent';
            } catch {
              /* fall through */
            }
          }
          toast.error(msg);
          return 'skipped';
        }
        return 'sent';
      }
      if (continueName && workbenchSession?.id) {
        try {
          await continueWorkstream(
            workbenchSession.id,
            continueName,
            text || ghostNext || 'Continue from the last episode.',
          );
          toast.success(`Continuing ${continueName}`);
          setInput('');
          setContinueWorkstream(null);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Continue failed');
          return 'skipped';
        }
        return 'sent';
      }
      return send(textOverride, options);
    },
    [focusedSubagent, continueName, ghostNext, input, send, setInput, workbenchSession?.id],
  );
  // Live markdown preview is opt-in — Ctrl/Cmd+Shift+P toggles it.
  const [showPreview, setShowPreview] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.shiftKey && !e.altKey && e.key === 'P') {
        e.preventDefault();
        setShowPreview(v => !v);
      }
      // Quick Entry — Cmd/Ctrl+Shift+Space focuses composer from anywhere
      if (cmd && e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        taRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const popovers = useComposerPopovers({
    input,
    setInput,
    taRef,
    dropdownApiRef,
    send: sendOrSteer,
    stop,
    streaming,
    sessionId,
    workbenchSessionId: workbenchSession?.id,
  });

  // Camera capture popover — anchors over the composer actions menu slot.
  const [cameraOpen, setCameraOpen] = useState(false);
  const handleCameraCapture = useCallback(
    (file: File) => {
      if (!attachFiles) return;
      void attachFiles([file]);
      setCameraOpen(false);
    },
    [attachFiles],
  );

  /* The command palette's "Switch model…" bumped a counter that opened
   * `ModelEffortMenu`, which only existed in the removed model row. Both the
   * counter and the palette item are gone with it — leaving either would be a
   * command that dispatches an action nothing listens for.
   *
   * `handoffPreparing` went with the rest: the row was the only caller of its
   * setter, so the toolbar's "Preparing handoff…" notice could never render.
   * That is a dead branch, not a temporarily-disabled feature. */

  // Arena ("ask in parallel") modal state.
  const [arenaOpen, setArenaOpen] = useState(false);
  // Debate (A5) modal state.
  const [debateOpen, setDebateOpen] = useState(false);

  // Value-driven auto-grow so clearing input after send collapses height
  // (onChange alone never fires for controlled setInput('')).
  const MAX_COMPOSER_H = 360;
  const resizeTextarea = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_COMPOSER_H);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_COMPOSER_H ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  return (
    <div className="august-composer-shell relative pb-3" ref={popovers.composerRootRef}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => {
          void handleFileUpload(e);
        }}
        multiple
        className="hidden"
      />

      <ComposerMentionsDropdown
        open={popovers.showToolsDropdown || popovers.showMentionsDropdown}
        pos={popovers.toolsPos}
        mentionQuery={popovers.mentionQuery}
        mentionItems={popovers.mentionItems}
        skillMentions={popovers.skillMentions}
        conversationMentions={popovers.conversationMentions}
        skillsLoading={popovers.skillsLoading}
        highlightedMentionIndex={popovers.highlightedMentionIndex}
        onPick={popovers.insertMention}
        onInsertToolText={(text) => {
          popovers.insertText(text);
          popovers.setShowToolsDropdown(false);
        }}
      />

      <ComposerCommandsDropdown
        open={popovers.showCommandsDropdown}
        pos={popovers.commandsPos}
        input={input}
        highlightedCommandIndex={popovers.highlightedCommandIndex}
        onPick={(name) => {
          popovers.insertCommand(name);
          popovers.setShowCommandsDropdown(false);
        }}
      />

      {/* SSE link dropped while the backend is otherwise fine. When messages
          are parked offline, the offline banner already explains the outage. */}
      {offlineCount === 0 ? (
        <StreamLinkBanner
          sessionId={workbenchSession?.id || activeWorkbenchSessionId || sessionId}
        />
      ) : null}

      {/* Offline compose banner (C9) */}
      {offlineCount > 0 ? (
        <div
          className="mb-1.5 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-2xs text-warning"
          data-testid="offline-banner"
        >
          <WifiOff className="size-3 shrink-0" />
          <span className="flex-1 min-w-0">
            Offline — {offlineCount} message{offlineCount === 1 ? '' : 's'} queued; sending when
            the backend returns.
          </span>
          <button
            type="button"
            onClick={onFlushOffline}
            className="rounded bg-warning/20 px-2 py-0.5 hover:bg-warning/30"
            data-testid="offline-flush-now"
          >
            Send now
          </button>
        </div>
      ) : null}

      {queuedMessages.length > 0 && sessionId && (
        <QueuePills
          sessionId={sessionId}
          workbenchSessionId={
            workbenchSession?.id || activeWorkbenchSessionId || sessionId
          }
          items={queuedMessages}
        />
      )}

      <div className="flex justify-center mb-1.5">
        <TaskProgressPill sessionId={sessionId} />
      </div>

      <div
        className={cn(
          'august-composer relative w-full min-w-0 rounded-2xl border bg-chat-input backdrop-blur-sm shadow-md',
          'border-border/70 overflow-visible',
        )}
      >
        {/* Jump-to-bottom, centered and straddling the card's top border.
            The button lives here (not in the message pane's corner) so the
            border is a stable anchor even when the rows above the card —
            stream-link banner, queue pills, task progress — change height. */}
        <div className="pointer-events-none absolute inset-x-0 -top-3 z-20 flex justify-center">
          <ScrollToBottomButton
            visible={scrolledFromBottom}
            onClick={onScrollToBottom}
            showNewContentPill={showNewContentPill}
          />
        </div>
        {voiceActive ? (
          <ComposerVoiceListening onStop={stopVoiceInput} />
        ) : (
          <>
            {/* Folder + branch context row — only on a fresh session (empty
                transcript), where the workspace choice is still open. Once the
                chat has messages the binding is fixed; the titlebar chips stay
                as the read-only context. */}
            <ComposerAttachmentChips
              attachments={attachments}
              onRemove={removeAttachment}
            />

            {sendKind === 'steer' || sendKind === 'continue' ? (
              <div
                className="px-4 pt-2 text-2xs text-muted-foreground"
                data-testid="composer-harness-chip"
              >
                {sendKind === 'steer'
                  ? `Steering ${focusedSubagent?.workstream || focusedSubagent?.title || 'worker'} (live)`
                  : `Will continue ${continueName || focusedSubagent?.workstream || 'workstream'}`}
                {ghostNext && sendKind === 'continue' ? ` · ${ghostNext}` : ''}
              </div>
            ) : null}
          </>
        )}

        {/* The composer ROW: the `+`, the input, the one primary action. The
            input lives INSIDE it because the reference's card is one row — an
            input with a control strip bolted underneath it is two rows, and two
            rows is what made August's composer read as a control panel. */}
        <ComposerToolbar
          sessionId={sessionId}
          loadedSessionId={loadedSessionId}
          /* The folder chip used to occupy its own full-width row INSIDE the
             card, which made the composer three stacked rows — chip, input,
             toolbar — where every reference has one. It rides the row's
             left cluster instead, beside the `+`. Only on a fresh session:
             once the chat has messages the binding is fixed and the titlebar
             chips are the read-only context. */
          folderSlot={
            messages.length === 0 ? (
              <ComposerWorkspaceChips
                sessionId={sessionId}
                workbenchSessionId={workbenchSession?.id || activeWorkbenchSessionId || null}
                workspacePath={workspacePath}
              />
            ) : null
          }
          input={input}
          attachmentsCount={readyAttachmentsCount ?? attachments.length}
          attachmentsReading={attachmentsReading}
          streaming={streaming}
          send={sendOrSteer}
          stop={stop}
          sendKind={streaming ? 'steer' : sendKind}
          ensureWorkbenchSession={ensureWorkbenchSession}
          workbenchSession={workbenchSession}
          setWorkbenchSession={setWorkbenchSession}
          workbenchMode={workbenchMode}
          setWorkbenchMode={setWorkbenchMode}
          sessionUsage={sessionUsage}
          visibleModels={visibleModels}
          selectedModel={selectedModel}
          actionsOpen={popovers.showComposerActionsDropdown}
          actionsPos={popovers.composerActionsPos}
          actionsTriggerRef={popovers.composerActionsTriggerRef}
          onToggleActions={() => {
            popovers.setShowComposerActionsDropdown((value) => !value);
            popovers.setShowToolsDropdown(false);
            popovers.setShowCommandsDropdown(false);
          }}
          onAttach={() => {
            fileInputRef.current?.click();
            popovers.setShowComposerActionsDropdown(false);
          }}
          onMention={popovers.openMentionPicker}
          onVoice={() => {
            startVoiceInput();
            popovers.setShowComposerActionsDropdown(false);
          }}
          onCamera={attachFiles ? () => {
            popovers.setShowComposerActionsDropdown(false);
            setCameraOpen((value) => !value);
          } : undefined}
          cameraOpen={cameraOpen}
          cameraPos={popovers.composerActionsPos}
          onCameraClose={() => setCameraOpen(false)}
          onCameraCapture={handleCameraCapture}
          onAskParallel={() => setArenaOpen(true)}
          onStartDebate={() => setDebateOpen(true)}
        >
          {voiceActive ? null : (
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                popovers.handleInputChange(e.target.value);
              }}
              onKeyDown={popovers.onKey}
              onPaste={handleComposerPaste}
              aria-label="Chat message"
              placeholder={
                streaming
                  ? 'Keep typing to queue follow-up changes'
                  : focusedSubagent
                    ? focusedSubagent.running === false && focusedSubagent.workstream
                      ? ghostNext || `Continue ${focusedSubagent.workstream}…`
                      : `Steer ${focusedSubagent.title} (next round)`
                    : continueName
                      ? ghostNext || `Continue workstream ${continueName}…`
                      : harnessMode === 'orchestrator'
                        ? 'Plan the next wave — or open Dispatch from +'
                        : 'Write a message…'
              }
              rows={1}
              /* The horizontal padding is small on purpose: the `+` and the
                 send circle now flank the text on the SAME row, so the text
                 starts right after the `+` — the reference's `+` sits
                 directly beside the placeholder. */
              className="w-full resize-none bg-transparent px-1 pt-2 pb-0.5 text-sm outline-none placeholder:text-muted-foreground/70"
              style={{ minHeight: '36px', maxHeight: '240px' }}
            />
          )}
        </ComposerToolbar>

        {showPreview && input.trim() && (
          <div
            className="border-t border-border bg-muted/5 max-h-[240px] overflow-y-auto px-4 py-2 text-foreground/90"
            aria-label="Message preview"
            data-testid="composer-preview"
          >
            <div className="text-2xs uppercase tracking-wider text-muted-foreground/70 mb-1.5 font-semibold">
              Preview
            </div>
            <Markdown content={input} />
          </div>
        )}
      </div>

      {/* Footer line under the card: disclaimer left, model + effort right,
          and the context percentage at the far right of the row.

          This renders `ModelEffortMenu`, whose own header already says it:
          "Claude draws this as plain text on its footer line — model at normal
          weight, effort lighter." It is borderless, border-pill-free, and was
          built for this exact slot.

          It was left unrendered when the composer model row was removed, which
          removed the LAST way to change the model: `open_model_picker` and the
          palette item went with it, and `useChatModels.selectModel` had no
          caller. Restoring only the *text* made it worse — it rendered
          `qwen3.8-flash medium` as inert copy, so the model was both visible
          and unchangeable.

          The only deviation from the reference is the chevron, which is hidden
          at rest and shown on hover/focus: the reference screenshot is a
          non-hovered state, but a control with no affordance at all is worse.

          The percentage goes at the END of this line — the reference puts it
          there ("Below the card, a single row: `+`, then a bordered model pill
          … and right-aligned a context percentage `3%`"), so it is the last
          thing in the row rather than part of the model cluster.

          The number is the LIVE one: the backend measures the turn's context
          occupancy server-side and ships it on the per-turn
          `contextPressure` event, which `store/contextLive.ts` keeps per
          session. It is deliberately NOT the persisted session-usage figure
          the cost chip reads — that poll is an aggregate over the session and
          its denominator was the hardcoded 128k fallback whenever a model
          carried no contextWindow of its own. The two readouts measure
          different things (money spent vs. window occupied), so they never
          contradict each other; and because the live number is keyed per
          session, switching chats cannot leave the previous session's
          percentage on screen.

          Before a session's first turn there is no measurement, and the
          readout renders nothing at all rather than a confident `0%`. */}
      <div
        className="mt-1.5 flex items-baseline justify-between gap-3 px-1 select-none"
        data-testid="composer-footer-row"
      >
        <p className="min-w-0 flex-1 truncate text-2xs text-muted-foreground/60">
          August is an AI assistant and can make mistakes. Please double-check responses.
        </p>
        <div className="flex shrink-0 items-baseline gap-2">
          <ModelEffortMenu
            visibleModels={visibleModels}
            selected={selectedModel}
            onSelect={onSelectModel}
            onEditModels={onEditModels}
            effort={effort}
            onEffortChange={onEffortChange}
            thinkingEnabled={thinkingEnabled}
            onThinkingChange={onThinkingChange}
          />
          <ContextUsageReadout sessionId={sessionId} />
        </div>
      </div>

      {debateOpen ? (
        <DebateLaunchModal
          models={visibleModels}
          initialPrompt={input}
          onClose={() => setDebateOpen(false)}
          onLaunch={(a, b, judge, rounds, prompt) => {
            setDebateOpen(false);
            onDebateLaunch?.(a, b, judge, rounds, prompt);
          }}
        />
      ) : null}

      {arenaOpen ? (
        <ArenaLaunchModal
          models={visibleModels}
          initialPrompt={input}
          onClose={() => setArenaOpen(false)}
          onLaunch={(targets, prompt) => {
            setArenaOpen(false);
            onArenaLaunch?.(targets, prompt);
          }}
        />
      ) : null}
    </div>
  );
}
