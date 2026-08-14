/* ── ChatThreadComposer ───────────────────────────────────────────────── */
/* Floating pill message box: attachments, @skills/tools, /commands,       */
/* model/effort menu, send / mid-run steer, stop.                          */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import type { WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
import { WorkspaceBranchChip } from '@/components/workspace/WorkspaceBranchChip';
import { QueuePills } from './QueuePills';
import { ArenaLaunchModal } from './composer/ArenaLaunchModal';
import { DebateLaunchModal } from './debate/DebateLaunchModal';
import type { DebateRun } from './debate/debate-store';
import { Swords, Gavel, WifiOff } from 'lucide-react';
import type { QueuedUserMessage } from './queue-store';
import { type ContextBreakdown } from './ChatComposer';
import { Markdown } from './ChatMarkdown';
import type { ModelItem } from './model-display';
import type { SessionUsageState } from './hooks/useChatUsage';
import type { EffortLevel } from './hooks/useChatSend';
import {
  useComposerPopovers,
  type ComposerDropdownApi,
} from './composer/useComposerPopovers';
import { onUiAction } from '@/api/ui-events';
import { ComposerAttachmentChips } from './composer/ComposerAttachmentChips';
import { ComposerMentionsDropdown } from './composer/ComposerMentionsDropdown';
import { ComposerCommandsDropdown } from './composer/ComposerCommandsDropdown';
import { ComposerToolbar } from './composer/ComposerToolbar';
import { ComposerVoiceListening } from './composer/ComposerVoiceListening';
import { toast } from 'sonner';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';
import { setContinueWorkstream, useContinueWorkstream } from '@/components/chat/composer-intent';
import { HarnessJobStrip } from '@/components/chat/HarnessJobStrip';
import { normalizeHarnessMode } from '@/components/chat/HarnessModeChip';
import { continueWorkstream, steer as steerSubagent } from '@/api/subagents';

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
  messages: ChatMessage[];
  streaming: boolean;
  send: (textOverride?: string) => Promise<void>;
  stop: () => void;
  /** Optional: lets the composer toolbar append a synthetic handoff-notice card. */
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  /** Creates the backend workbench session on demand (used by the verifier
   *  toggle on fresh chats where no session exists before the first send). */
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
  pct: number;
  estTokens: number;
  maxContext: number;
  contextBreakdown: ContextBreakdown;
  sessionUsage: SessionUsageState;
  modelForRequest: ModelItem | null;
  models: ModelItem[];
  visibleModels: ModelItem[];
  modelsLoading: boolean;
  selectedModel: ModelItem | null;
  setSelectedModel: Dispatch<SetStateAction<ModelItem | null>>;
  userSelectedRef: MutableRefObject<string | null>;
  onRefreshModels: () => void;
  onEditModels: () => void;
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
  effort: EffortLevel;
  setEffort: Dispatch<SetStateAction<EffortLevel>>;
  thinkingEnabled: boolean;
  setThinkingEnabled: Dispatch<SetStateAction<boolean>>;
  voiceActive: boolean;
  startVoiceInput: () => void;
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
    messages,
    streaming,
    send,
    stop,
    setMessages,
    ensureWorkbenchSession,
    queuedMessages,
    workbenchSession,
    setWorkbenchSession,
    workbenchMode,
    setWorkbenchMode,
    workspacePath,
    activeWorkbenchSessionId,
    pct,
    estTokens,
    maxContext,
    contextBreakdown,
    sessionUsage,
    modelForRequest,
    models,
    visibleModels,
    modelsLoading,
    selectedModel,
    setSelectedModel,
    userSelectedRef,
    onRefreshModels,
    onEditModels,
    onArenaLaunch,
    onDebateLaunch,
    offlineCount = 0,
    onFlushOffline,
    effort,
    setEffort,
    thinkingEnabled,
    setThinkingEnabled,
    voiceActive,
    startVoiceInput,
    dropdownApiRef,
  } = props;

  const navigate = useNavigate();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusedSubagent = useFocusedSubagent();
  const continueName = useContinueWorkstream();
  const harnessMode = normalizeHarnessMode(workbenchSession?.agentMode);
  const sendKind =
    focusedSubagent ? 'steer' : continueName ? 'continue' : harnessMode === 'orchestrator' ? 'dispatch' : 'send';
  const sendOrSteer = useCallback(
    async (textOverride?: string) => {
      const text = (textOverride ?? input).trim();
      if (focusedSubagent && text) {
        try {
          await steerSubagent(focusedSubagent.jobId, text);
          toast.success(`Queued for ${focusedSubagent.title} (next round)`);
          setInput('');
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Steer failed');
        }
        return;
      }
      if (continueName && text && workbenchSession?.id) {
        try {
          await continueWorkstream(workbenchSession.id, continueName, text);
          toast.success(`Continuing ${continueName}`);
          setInput('');
          setContinueWorkstream(null);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Continue failed');
        }
        return;
      }
      return send(textOverride);
    },
    [focusedSubagent, continueName, input, send, setInput, workbenchSession?.id],
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
  });

  // Command palette "Switch model" → bump the counter so the model menu
  // opens (ModelEffortMenu re-fires on each increment).
  const [modelMenuSignal, setModelMenuSignal] = useState(0);
  useEffect(() => {
    const unsub = onUiAction((e) => {
      if (e.action === 'open_model_picker') setModelMenuSignal((n) => n + 1);
    });
    return unsub;
  }, []);

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

      {/* Offline compose banner (C9) */}
      {offlineCount > 0 ? (
        <div
          className="mb-1.5 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"
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

      <HarnessJobStrip sessionId={workbenchSession?.id || activeWorkbenchSessionId || sessionId} />

      {queuedMessages.length > 0 && sessionId && (
        <QueuePills
          sessionId={sessionId}
          workbenchSessionId={
            workbenchSession?.id || activeWorkbenchSessionId || sessionId
          }
          items={queuedMessages}
        />
      )}

      <div
        className={cn(
          'august-composer w-full min-w-0 rounded-3xl border bg-chat-input backdrop-blur-sm shadow-lg',
          'border-border/70 overflow-visible',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40">
          <WorkspaceSelector
            sessionId={sessionId}
            onWorkspaceChange={(ws) => {
              if (!ws) return;
              void import('@/store/sessions').then(
                ({ bindSessionToWorkspacePath, findOrCreateSessionForPath }) => {
                  // New filesystem paths always get a Repositories folder.
                  // Prefer binding the current chat so it lands under that folder
                  // instead of spawning an orphan "Project:" session.
                  if (sessionId) {
                    bindSessionToWorkspacePath(sessionId, ws.path, ws.name);
                    return;
                  }
                  const { session } = findOrCreateSessionForPath(ws.path, ws.name);
                  void navigate(`/c/${session.id}`);
                },
              );
            }}
          />
          <WorkspaceBranchChip
            sessionId={sessionId}
            repoPath={workspacePath}
          />
        </div>

        {voiceActive ? (
          <ComposerVoiceListening />
        ) : (
          <>
            <ComposerAttachmentChips
              attachments={attachments}
              onRemove={removeAttachment}
            />

            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                popovers.handleInputChange(e.target.value);
              }}
              onKeyDown={popovers.onKey}
              onPaste={handleComposerPaste}
              placeholder={
                streaming
                  ? 'Add a direction while August works…'
                  : focusedSubagent
                    ? `Steer ${focusedSubagent.title} (next round)`
                    : continueName
                      ? `Continue workstream ${continueName}…`
                      : harnessMode === 'orchestrator'
                        ? 'Plan the next wave — or open Dispatch from +'
                        : 'Write a message...'
              }
              rows={1}
              className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm outline-none placeholder:text-muted-foreground/70"
              style={{ minHeight: '52px', maxHeight: '360px' }}
            />

            {showPreview && input.trim() && (
              <div
                className="border-t border-border bg-muted/5 max-h-[240px] overflow-y-auto px-4 py-2 text-foreground/90"
                aria-label="Message preview"
                data-testid="composer-preview"
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5 font-semibold">
                  Preview
                </div>
                <Markdown content={input} />
              </div>
            )}
          </>
        )}

        <ComposerToolbar
          sessionId={sessionId}
          loadedSessionId={loadedSessionId}
          input={input}
          attachmentsCount={readyAttachmentsCount ?? attachments.length}
          attachmentsReading={attachmentsReading}
          streaming={streaming}
          send={sendOrSteer}
          stop={stop}
          sendKind={streaming ? 'steer' : sendKind}
          setMessages={setMessages}
          ensureWorkbenchSession={ensureWorkbenchSession}
          workbenchSession={workbenchSession}
          setWorkbenchSession={setWorkbenchSession}
          workbenchMode={workbenchMode}
          setWorkbenchMode={setWorkbenchMode}
          workspacePath={workspacePath}
          pct={pct}
          estTokens={estTokens}
          maxContext={maxContext}
          contextBreakdown={contextBreakdown}
          sessionUsage={sessionUsage}
          modelForRequest={modelForRequest}
          models={models}
          visibleModels={visibleModels}
          modelsLoading={modelsLoading}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          userSelectedRef={userSelectedRef}
          onRefreshModels={onRefreshModels}
          onEditModels={onEditModels}
          effort={effort}
          setEffort={setEffort}
          thinkingEnabled={thinkingEnabled}
          setThinkingEnabled={setThinkingEnabled}
          modelMenuOpenSignal={modelMenuSignal}
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
        />
        <button
          type="button"
          onClick={() => setArenaOpen(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-muted/60 transition shrink-0"
          title="Ask in parallel — run this prompt on 2–3 models and pick the best"
          aria-label="Ask in parallel"
          data-testid="arena-open"
        >
          <Swords className="size-3.5" />
          Parallel
        </button>
        <button
          type="button"
          onClick={() => setDebateOpen(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-muted/60 transition shrink-0"
          title="Structured debate — two models argue this prompt, optional judge"
          aria-label="Start a debate"
          data-testid="debate-open"
        >
          <Gavel className="size-3.5" />
          Debate
        </button>
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
