/* ── ChatThreadComposer ───────────────────────────────────────────────── */
/* Message box: attachments, @skills/tools, /commands, queue pills, mode,   */
/* model/effort, context ring, send / mid-run steer, stop.                 */

import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { cn } from '@/lib/utils';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import type { WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { WorkspaceSelector } from '@/components/workspace/WorkspaceSelector';
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

export type { ComposerDropdownApi };

export interface ChatThreadComposerProps {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: FileAttachment[];
  removeAttachment: (index: number) => void;
  handleComposerPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
  messages: ChatMessage[];
  streaming: boolean;
  send: (textOverride?: string) => Promise<void>;
  stop: () => void;
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
    removeAttachment,
    handleComposerPaste,
    handleFileUpload,
    messages,
    streaming,
    send,
    stop,
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
    voiceActive,
    startVoiceInput,
    dropdownApiRef,
  } = props;

  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  return (
    <div className="relative" ref={popovers.composerRootRef}>
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
          'w-full min-w-0 rounded-2xl border bg-card shadow-sm transition focus-within:ring-2 focus-within:ring-primary/40 focus-within:border-primary overflow-visible',
          'border-border',
        )}
      >
        {messages.length === 0 && (
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/50">
            <WorkspaceSelector
              sessionId={sessionId}
              onWorkspaceChange={(ws) => {
                if (!sessionId || !ws) return;
                void import('@/store/sessions').then(({ createSession, $sessions }) => {
                  const existing = $sessions.get().find((s) => s.workspacePath === ws.path);
                  if (existing) {
                    window.location.href = `/c/${existing.id}`;
                  } else {
                    const newSess = createSession(null, ws.name || 'New Chat', ws.path);
                    window.location.href = `/c/${newSess.id}`;
                  }
                });
              }}
            />
          </div>
        )}

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
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 360) + 'px';
              }}
              onKeyDown={popovers.onKey}
              onPaste={handleComposerPaste}
              placeholder={
                streaming
                  ? 'Add a direction while August works… (applied after the next tool step)'
                  : 'Enter message… (use / for commands)'
              }
              rows={1}
              className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-xs outline-none placeholder:text-muted-foreground"
              style={{ minHeight: '64px', maxHeight: '360px' }}
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
          attachmentsCount={attachments.length}
          streaming={streaming}
          send={send}
          stop={stop}
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
