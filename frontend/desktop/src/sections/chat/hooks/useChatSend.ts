/* ── useChatSend ─────────────────────────────────────────────────────── */
/* Sends user messages to the workbench chat loop, including slash         */
/* commands and mid-run steer. Also starts the assistant generate turn.   */

import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import {
  voiceCommandRegistry,
  type ChatMessageLite,
} from '@/api/voice/registry';
import { queueWorkbenchMessage } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import {
  useSessionsStore,
  renameSession,
  deriveSessionTitleFromMessage,
  updateSessionModel,
} from '@/store/sessions';
import {
  WORKBENCH_GUARD_MODES,
  applyWorkbenchGuardMode,
  type WorkbenchGuardMode,
} from '@/components/chat/WorkbenchModeSelector';
import { chatRuntime } from '../chat-runtime';
import {
  startChatStream,
  activeStreamControllers,
} from '../chat-stream-manager';
import {
  $queuedMessagesBySession,
  setQueuedMessages,
  type QueuedUserMessage,
} from '../queue-store';
import {
  clearComposerDraft,
  persistMessages,
} from '../message-storage';
import type { ModelItem } from '../model-display';
import { ChatSendService } from '../services/ChatSendService';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface UseChatSendOptions {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: FileAttachment[];
  clearAttachments: () => void;
  /** Composer text + attachment sections (from useChatAttachments). */
  composeText: (text: string) => string;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  streaming: boolean;
  workbenchSessionId: string | null | undefined;
  activeWorkbenchSessionId: string | null | undefined;
  queuedMessages: QueuedUserMessage[];
  modelForRequest: ModelItem | null;
  workbenchMode: WorkbenchGuardMode;
  effort: EffortLevel;
  ensureWorkbenchSession: () => Promise<WorkbenchSession | null>;
  setShowToolsDropdown: (open: boolean) => void;
  setShowCommandsDropdown: (open: boolean) => void;
  /**
   * Session message loader (demo thread + localStorage). ChatThread passes
   * its demo-aware loader so mid-send history stays consistent with the UI.
   */
  loadMessagesForSession: (sessionId: string | null) => ChatMessage[];
}

/**
 * Owns the composer send path: local slash dispatch, mid-run steer queueing,
 * normal user-turn append + generate, and draining leftover queue entries
 * after a stream ends without the backend consuming them.
 */
export function useChatSend(opts: UseChatSendOptions) {
  const {
    sessionId,
    loadedSessionId,
    input,
    setInput,
    attachments,
    clearAttachments,
    composeText,
    messages,
    setMessages,
    streaming,
    workbenchSessionId,
    activeWorkbenchSessionId,
    queuedMessages,
    modelForRequest,
    workbenchMode,
    effort,
    ensureWorkbenchSession,
    setShowToolsDropdown,
    setShowCommandsDropdown,
    loadMessagesForSession,
  } = opts;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const generateAIResponse = useCallback(
    async (chatHistory: ChatMessage[]) => {
      const turnSessionId = sessionId;
      if (!turnSessionId) return;
      if (!chatRuntime.canStartTurn(turnSessionId)) {
        // Stale runtime turn with no live controller — clear and proceed.
        if (!activeStreamControllers.has(turnSessionId)) {
          chatRuntime.abortSession(turnSessionId);
        } else {
          // Real in-flight stream: queue on backend instead of dropping.
          const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
          const text = lastUser?.content?.trim() || '';
          if (text) {
            try {
              const wbId = ChatSendService.resolveWorkbenchQueueId(
                workbenchSessionId,
                activeWorkbenchSessionId,
                turnSessionId,
              );
              const entry = await queueWorkbenchMessage(wbId, text);
              setQueuedMessages(turnSessionId, [
                ...($queuedMessagesBySession.get()[turnSessionId] ?? []),
                entry,
              ]);
              toast.message('Queued — will send when the current response finishes');
            } catch {
              toast.error('Could not start a new response — one is already running');
            }
          }
          return;
        }
      }

      // Backend session already holds history — only send the new user turn.
      // Sending the full transcript as one blob every time bloated context and
      // could make the model/provider look "stuck" or fail silently on large chats.
      const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
      const latestText = (lastUser?.content ?? '').trim();
      if (!latestText) {
        toast.error('Nothing to send');
        return;
      }

      if (!modelForRequest?.id) {
        toast.error('Select a model first (e.g. a free OpenCode model)');
        return;
      }
      if (!modelForRequest.provider) {
        toast.error('Selected model has no provider — pick it again from the model list');
        return;
      }

      const result = await startChatStream(turnSessionId, {
        message: applyWorkbenchGuardMode(workbenchMode, latestText),
        chatHistory,
        workbenchMode,
        effort,
        model: modelForRequest.id,
        // Always pass the provider that owns this model (name or id). Without
        // it, free claude-like ids can resolve to bare Anthropic with no key.
        modelProvider: modelForRequest.provider,
        provider: modelForRequest.provider,
        agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
        guardMode: workbenchMode,
        ensureWorkbenchSession,
      });
      if (result === 'error') {
        toast.error('Chat failed — check backend and model provider');
      }
    },
    [
      sessionId,
      workbenchSessionId,
      activeWorkbenchSessionId,
      modelForRequest,
      workbenchMode,
      effort,
      ensureWorkbenchSession,
    ],
  );

  // Fallback drain: if the model never picked up the queued messages
  // (e.g. the user cancelled the response mid-stream), the queue still
  // holds entries when streaming ends. In that case we synthesize a
  // fresh user message from the queued text and start a new turn. The
  // backend already removes the entries when it drains them in-loop, so
  // the queue store should be empty in the normal flow.
  useEffect(() => {
    if (!sessionId || streaming) return;
    const leftover = queuedMessages;
    if (leftover.length === 0) return;
    // Defer so we don't race with the finalize() of the just-ended turn.
    const timer = setTimeout(() => {
      const stillQueued = $queuedMessagesBySession.get()[sessionId] ?? [];
      if (stillQueued.length === 0) return;
      const first = stillQueued[0];
      const rest = stillQueued.slice(1);
      const userMsg: ChatMessage = {
        id: `m${Date.now()}`,
        role: 'user',
        content: first.text,
        timestamp: new Date().toISOString(),
        attachments: first.attachments,
        queued: true,
      };
      const remaining = [...messagesRef.current, userMsg];
      setMessages(remaining);
      persistMessages(sessionId, remaining);
      // Drop the entry we just consumed locally; the backend will see an
      // empty queue when we POST the next /chat call.
      setQueuedMessages(sessionId, rest);
      setTimeout(() => {
        void generateAIResponse(remaining);
      }, 0);
    }, 0);
    return () => clearTimeout(timer);
    // Intentionally narrow deps: only re-arm when stream ends or session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, sessionId]);

  const send = useCallback(
    async (textOverride?: string) => {
      if (!sessionId) {
        toast.error('No active session');
        return;
      }
      if (loadedSessionId !== sessionId) {
        toast.error('Session is still loading — try again in a moment');
        return;
      }

      const text = composeText(textOverride ?? input);
      if (!text && attachments.length === 0) return;

      // Local slash command dispatch — handle purely client-side commands
      // before sending to the backend. The workbench backend intercepts
      // /btw and /goal at workbench.js and answers them without pushing a
      // user message into the session, so we let those fall through to the
      // normal send path.
      //
      // Registry-driven dispatch: the handler mutates state (via the registry
      // event bus) and clears the composer / draft. Handlers that need data
      // from the backend (e.g. /load, /skills) emit events ChatThread
      // subscribes to.
      const slash = ChatSendService.parseSlashCommand(text);
      if (slash) {
        const voiceCmd = voiceCommandRegistry.getBySlashCommand('/' + slash.cmd);
        if (voiceCmd) {
          try {
            // Voice command handlers accept the lite `ChatMessageLite[]` view;
            // cast across the boundary since the full `ChatMessage[]` carries
            // every lite field plus extras (timestamp, attachments, blocks, …).
            const handlerResult = voiceCmd.handler({
              sessionId: sessionId ?? '',
              transcript: text,
              args: slash.arg,
              messages: messages as unknown as ChatMessageLite[],
              setMessages: setMessages as unknown as Dispatch<
                SetStateAction<ChatMessageLite[]>
              >,
            });
            void Promise.resolve(handlerResult).catch((err) => {
              console.error('[slash] handler threw', err);
              toast.error('Command failed');
            });
            setShowCommandsDropdown(false);
            setShowToolsDropdown(false);
            // Most handlers clear the composer themselves; the registry
            // contract is that they do so for client-only commands.
            // For commands that should fall through to the backend (e.g.
            // /btw with an arg), the handler should NOT clear the composer.
            return;
          } catch (err) {
            console.error('[slash] handler threw synchronously', err);
            toast.error('Command failed');
            return;
          }
        }
        // Unrecognized slash command — let the backend handle it (or no-op).
      }

      // While streaming: mid-run STEER (course correction) — applies at the
      // next tool/LLM boundary without cancelling the turn (Hermes-style /steer).
      if (streaming && sessionId) {
        try {
          const savedAttachments =
            attachments.length > 0 ? [...attachments] : undefined;
          const wbId = ChatSendService.resolveWorkbenchQueueId(
            workbenchSessionId,
            activeWorkbenchSessionId,
            sessionId,
          );
          const entry = await queueWorkbenchMessage(
            wbId,
            text,
            savedAttachments,
            'steer',
          );
          // Optimistic local update: the SSE event will also arrive and
          // upsert the same entry (idempotent), but write immediately so
          // the pill is visible without a round-trip.
          setQueuedMessages(sessionId, [...queuedMessages, entry]);
          setInput('');
          clearAttachments();
          setShowToolsDropdown(false);
          setShowCommandsDropdown(false);
          clearComposerDraft(sessionId);
          toast.message('Direction queued', {
            description: 'August will apply this after the current tool step.',
          });
        } catch (err) {
          console.error('[send] steer failed', err);
          toast.error('Could not add direction');
        }
        return;
      }

      const currentMessages =
        sessionId === loadedSessionId
          ? messages
          : loadMessagesForSession(sessionId);

      // Auto-title when the sidebar still has a placeholder title (first real
      // user message, or after a failed earlier attempt). Backend also auto-titles
      // on stream start; this keeps local UI instant.
      const activeSess = useSessionsStore
        .getState()
        .sessions.find(
          (s) => s.id === sessionId || s.workbenchSessionId === sessionId,
        );
      const needsTitle = ChatSendService.sessionNeedsAutoTitle(activeSess?.title);
      if (sessionId && needsTitle) {
        if (!ChatSendService.isCommandText(text)) {
          const title = deriveSessionTitleFromMessage(text);
          if (title) renameSession(sessionId, title);
        }
      }

      // Save the selected model on this session only; do not change global defaults.
      if (sessionId && modelForRequest) {
        updateSessionModel(
          sessionId,
          modelForRequest.id,
          modelForRequest.provider,
        );
      }

      setInput('');
      clearComposerDraft(sessionId);
      const savedAttachments =
        attachments.length > 0 ? [...attachments] : undefined;
      clearAttachments();
      setShowToolsDropdown(false);
      setShowCommandsDropdown(false);

      const userMsg: ChatMessage = {
        id: `m${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        attachments: savedAttachments,
      };

      const nextMessages = [...currentMessages, userMsg];
      setMessages(nextMessages);
      persistMessages(sessionId, nextMessages);
      // Pass the FULL message history — generateAIResponse builds the new
      // messages state from this argument, so passing only `[userMsg]` would
      // overwrite the existing list with just two entries and wipe the prior
      // conversation from view and from localStorage.
      await generateAIResponse(nextMessages);
    },
    [
      sessionId,
      loadedSessionId,
      composeText,
      input,
      attachments,
      messages,
      setMessages,
      streaming,
      workbenchSessionId,
      activeWorkbenchSessionId,
      queuedMessages,
      modelForRequest,
      setInput,
      clearAttachments,
      setShowToolsDropdown,
      setShowCommandsDropdown,
      loadMessagesForSession,
      generateAIResponse,
    ],
  );

  return { send, generateAIResponse };
}
