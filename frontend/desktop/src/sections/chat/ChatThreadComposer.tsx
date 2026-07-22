/* ── ChatThreadComposer ───────────────────────────────────────────────── */
/* Floating pill message box: attachments, @skills/tools, /commands,       */
/* model/effort menu, send / mid-run steer, stop.                          */

import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import type { WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
import { WorkspaceBranchChip } from '@/components/workspace/WorkspaceBranchChip';
import { QueuePills } from './QueuePills';
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
import { ComposerAttachmentChips } from './composer/ComposerAttachmentChips';
import { ComposerMentionsDropdown } from './composer/ComposerMentionsDropdown';
import { ComposerCommandsDropdown } from './composer/ComposerCommandsDropdown';
import { ComposerToolbar } from './composer/ComposerToolbar';
import { ComposerVoiceListening } from './composer/ComposerVoiceListening';
import { useFocusedSubagent } from '@/components/chat/focused-subagent';

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
  // Live markdown preview is opt-in; toolbar toggle removed for now.
  // TODO: re-enable via keyboard shortcut (e.g. Ctrl/Cmd+Shift+P)
  const [showPreview, setShowPreview] = useState(false);
  void setShowPreview;

  const popovers = useComposerPopovers({
    input,
    setInput,
    taRef,
    dropdownApiRef,
    send,
  });

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
    <div className="relative pb-3" ref={popovers.composerRootRef}>
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

      {queuedMessages.length > 0 && sessionId && (
        <QueuePills
          sessionId={sessionId}
          workbenchSessionId={
            workbenchSession?.id || activeWorkbenchSessionId || sessionId
          }
          items={queuedMessages}
        />
      )}
      {streaming && queuedMessages.length === 0 && (
        <div className="mb-1.5 px-1 text-[10px] text-muted-foreground/80 animate-in fade-in duration-150">
          Tip: type a direction while August works — it applies after the next tool step
          without stopping.
        </div>
      )}

      <div
        className={cn(
          'w-full min-w-0 rounded-3xl border bg-card/95 backdrop-blur-sm shadow-lg',
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
                    ? 'Send follow-up with subagent'
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
          send={send}
          stop={stop}
          setMessages={setMessages}
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
      </div>
    </div>
  );
}
