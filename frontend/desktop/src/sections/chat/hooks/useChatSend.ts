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
import { useNavigate } from 'react-router-dom';
import {
  voiceCommandRegistry,
  type ChatMessageLite,
} from '@/api/voice/registry';
import { dequeueWorkbenchMessage, queueWorkbenchMessage } from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, FileAttachment } from '@/types/chat';
import { ChatAttachmentService } from '../services/ChatAttachmentService';
import { updateSessionModel, renameSession, isPlaceholderTitle, deriveSnippetTitle, useSessionsStore } from '@/store/sessions';
import { buildGitContextBlock } from '@/lib/git-context';
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
import { enqueueOfflineMessage } from '../offline-queue-store';
import { $gateway } from '@/store/gateway';
import type { ModelItem } from '../model-display';
import { ChatSendService } from '../services/ChatSendService';
import { playSendChime } from '@/lib/chat-chime';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** Strip ephemeral upload UI fields before persisting on a sent message. */
function persistAttachment(a: FileAttachment): FileAttachment {
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    path: a.path,
    content: a.content,
    dataUrl: a.dataUrl,
    thumbnailUrl: a.thumbnailUrl,
    type: a.type,
    truncated: a.truncated,
    status: 'ready',
  };
}

export interface UseChatSendOptions {
  sessionId: string | null;
  loadedSessionId: string | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachments: FileAttachment[];
  clearAttachments: () => void;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  streaming: boolean;
  workbenchSessionId: string | null | undefined;
  activeWorkbenchSessionId: string | null | undefined;
  queuedMessages: QueuedUserMessage[];
  modelForRequest: ModelItem | null;
  workbenchMode: WorkbenchGuardMode;
  effort: EffortLevel;
  /** When false, skip requesting extended thinking / reasoning for this turn. */
  thinkingEnabled: boolean;
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
  const navigate = useNavigate();
  const {
    sessionId,
    loadedSessionId,
    input,
    setInput,
    attachments,
    clearAttachments,
    messages,
    setMessages,
    streaming,
    workbenchSessionId,
    activeWorkbenchSessionId,
    queuedMessages,
    modelForRequest,
    workbenchMode,
    effort,
    thinkingEnabled,
    ensureWorkbenchSession,
    setShowToolsDropdown,
    setShowCommandsDropdown,
    loadMessagesForSession,
  } = opts;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Latest-model ref (same pattern as messagesRef): generateAIResponse is
  // read from captured closures (generateRef, drain effect) that can lag a
  // render behind a model switch — the ref always carries the fresh pick.
  const modelForRequestRef = useRef(modelForRequest);
  modelForRequestRef.current = modelForRequest;

  // 3.3: the "Chat failed → Retry" action lives inside generateAIResponse's
  // closure, but `send` is defined after it and is NOT in generateAIResponse's
  // dep array — calling `send` directly would capture a stale callback. Route
  // the retry through a ref that always points at the latest `send`.
  const sendRef = useRef<(textOverride?: string) => Promise<void>>(async () => {});

  // (b) Double-Enter latch: the second send in the same frame sees a stale
  // `input`/`streaming` closure and would append a duplicate user bubble
  // (then the backend queues a duplicate turn). The latch is held from
  // send() entry until the turn is registered (or the send bails), and
  // released in the turn's terminal handlers / early returns so mid-run
  // steering keeps working.
  const sendingRef = useRef(false);
  const releaseSendLatch = () => {
    sendingRef.current = false;
  };

  const generateAIResponse = useCallback(
    async (chatHistory: ChatMessage[]) => {
      const turnSessionId = sessionId;
      if (!turnSessionId) {
        releaseSendLatch();
        return;
      }
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
          releaseSendLatch();
          return;
        }
      }

      // Backend session already holds history — only send the new user turn.
      // Sending the full transcript as one blob every time bloated context and
      // could make the model/provider look "stuck" or fail silently on large chats.
      const lastUser = [...chatHistory].reverse().find((m) => m.role === 'user');
      // Compose attachment prompt at send time so message.content stays
      // display-friendly (typed text only) while the model still gets file text.
      const latestText = ChatAttachmentService.composeUserText(
        lastUser?.content ?? '',
        lastUser?.attachments ?? [],
      ).trim();
      if (!latestText) {
        toast.error('Nothing to send');
        releaseSendLatch();
        return;
      }

      // Read the model from the ref: this callback is invoked from captured
      // closures (drain effect, generateRef) whose prop snapshot can be one
      // model-switch stale.
      const useModel = modelForRequestRef.current;
      if (!useModel?.id) {
        toast.error('Select a model first (e.g. a free OpenCode model)');
        releaseSendLatch();
        return;
      }
      if (!useModel.provider) {
        toast.error('Selected model has no provider — pick it again from the model list');
        releaseSendLatch();
        return;
      }

      // @git mention: attach a compact git snapshot to the request only
      // (the displayed bubble keeps the typed text clean).
      let requestText = latestText;
      if (/@git\b/.test(latestText)) {
        const gitContext = await buildGitContextBlock(sessionId);
        if (gitContext) requestText = `${latestText}\n\n${gitContext}`;
      }
      // Bot Mode @-mention middleware (Phase C, OQ8): annotation ONLY. Resolve
      // @handles against the live roster and append an identification note to
      // the OUTGOING text (request-only; the bubble stays clean). The current
      // agent decides whether to call message_agent — user text is never
      // piped into another Bot. Unknown handles pass through untouched.
      if (/@[\w.-]+/.test(requestText)) {
        try {
          const mentions = await import('../composer-mentions');
          const roster = await mentions.getBotRoster();
          requestText = mentions.annotateBotMentions(requestText, roster);
        } catch {
          /* roster unavailable — send the clean text, no annotation */
        }
      }

      const streamPromise = startChatStream(turnSessionId, {
        message: applyWorkbenchGuardMode(workbenchMode, requestText),
        chatHistory,
        workbenchMode,
        effort,
        // Honor the user's toggle for every model — backend drops reasoning
        // deltas when false, and skips requesting extended thinking when off.
        thinkingEnabled,
        model: useModel.id,
        // Always pass the provider that owns this model (name or id). Without
        // it, free claude-like ids can resolve to bare Anthropic with no key.
        modelProvider: useModel.provider,
        provider: useModel.provider,
        agentId: WORKBENCH_GUARD_MODES[workbenchMode].agentId,
        guardMode: workbenchMode,
        ensureWorkbenchSession,
      });
      // startChatStream registers the AbortController + runtime turn
      // synchronously before its first await — the send is no longer
      // "in flight", so release the latch: re-entrant sends now take the
      // mid-run steer path instead of being swallowed.
      releaseSendLatch();
      const result = await streamPromise;
      if (result === 'error') {
        // Actionable error: retry the same message or jump to provider
        // settings — never leave the user with a dead-end "Chat failed".
        toast.error('Chat failed', {
          description: 'The backend or model provider rejected the request.',
          action: {
            label: 'Retry',
            // Retry the CLEAN user text, not `requestText` — requestText
            // already carries the @git block and the Bot-Mode @mentions note,
            // and send() re-runs both annotators, so passing it would stack a
            // second git block + a second bot note on every retry.
            onClick: () => void sendRef.current(latestText),
          },
          cancel: {
            label: 'Provider settings',
            onClick: () => void navigate('/settings/model-providers'),
          },
        });
      } else if (result === 'queued') {
        toast.message('Message queued', {
          description: 'It will run when the current response finishes.',
        });
      }
    },
    [
      sessionId,
      workbenchSessionId,
      activeWorkbenchSessionId,
      modelForRequest,
      workbenchMode,
      effort,
      thinkingEnabled,
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
      // Drop the entry we just consumed locally, and dequeue it from the
      // backend too — with stop now preserving the queue, a leftover entry
      // would otherwise be injected twice (once via this re-send, once by
      // the next turn's in-loop drain).
      setQueuedMessages(sessionId, rest);
      const wbId = ChatSendService.resolveWorkbenchQueueId(
        workbenchSessionId,
        activeWorkbenchSessionId,
        sessionId,
      );
      void dequeueWorkbenchMessage(wbId, first.id).catch(() => undefined);
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
      // (b) Double-Enter in the same frame: the second call sees a stale
      // `input`/`streaming` closure and would append a duplicate bubble.
      // Ignore re-entry while a send is in flight (released when the turn
      // registers or the send bails — see releaseSendLatch).
      if (sendingRef.current) return;
      sendingRef.current = true;

      if (!sessionId) {
        toast.error('No active session');
        releaseSendLatch();
        return;
      }
      if (loadedSessionId !== sessionId) {
        toast.error('Session is still loading — try again in a moment');
        releaseSendLatch();
        return;
      }

      // (a) Model guard BEFORE mutating state: appending the user bubble and
      // persisting it first meant a send with no selected model left a ghost
      // persisted bubble when generateAIResponse bailed with this toast.
      if (!modelForRequest?.id) {
        toast.error('Select a model first (e.g. a free OpenCode model)');
        releaseSendLatch();
        return;
      }
      if (!modelForRequest?.provider) {
        toast.error('Selected model has no provider — pick it again from the model list');
        releaseSendLatch();
        return;
      }

      if (ChatAttachmentService.isReading(attachments)) {
        toast.message('Still attaching files…', {
          description: 'Wait for uploads to finish before sending.',
        });
        releaseSendLatch();
        return;
      }

      const readyAttachments = ChatAttachmentService.readyOnly(attachments);
      // Keep bubble content as the typed text only; compose attachment dump
      // later when calling the model (see generateAIResponse).
      const typed = (textOverride ?? input).trim();
      if (!typed && readyAttachments.length === 0) {
        releaseSendLatch();
        return;
      }
      const text = typed;

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
            releaseSendLatch();
            return;
          } catch (err) {
            console.error('[slash] handler threw synchronously', err);
            toast.error('Command failed');
            releaseSendLatch();
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
            readyAttachments.length > 0
              ? readyAttachments.map(persistAttachment)
              : undefined;
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
            description: 'Applied after the current tool step.',
          });
        } catch (err) {
          console.error('[send] steer failed', err);
          toast.error('Could not add direction');
        }
        releaseSendLatch();
        return;
      }

      const currentMessages =
        sessionId === loadedSessionId
          ? messages
          : loadMessagesForSession(sessionId);

      // Offline compose (C9): if the backend is unreachable, park the
      // message in the offline queue instead of failing silently — it
      // flushes automatically when the backend returns.
      const readyForSend = readyAttachments;
      try {
        // The gateway store is authoritative for boot state: while the
        // backend is still starting (status 'connecting'), a 2s health probe
        // false-positives and parks the message as "Offline" on first launch
        // (backend can take 45s+ to bootstrap).
        const gw = $gateway.get();
        if (gw.status === 'open') {
          // Poller already confirmed the backend — send directly.
        } else if (gw.status === 'closed' || gw.status === 'error') {
          // Tie-break: the poller may be stale (backend just came back).
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2000);
          const res = await fetch('/api/health', { signal: ctrl.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error('backend unhealthy');
        } else {
          // Still booting — wait (capped) for the poller to flip to open
          // instead of mislabeling a cold start as offline.
          const deadline = Date.now() + 10_000;
          while ($gateway.get().status === 'connecting' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
          }
          if ($gateway.get().status !== 'open') throw new Error('backend not ready');
        }
      } catch {
        enqueueOfflineMessage(
          sessionId,
          text,
          readyForSend.length > 0 ? readyForSend.map(persistAttachment) : undefined,
        );
        toast.message('Offline — message saved', {
          description: 'It will send automatically when the backend is back.',
        });
        setInput('');
        clearComposerDraft(sessionId);
        setShowToolsDropdown(false);
        setShowCommandsDropdown(false);
        releaseSendLatch();
        return;
      }

      // §5.2: title immediately from the first real message — the snippet
      // shows in the sidebar at send time; the backend LLM titler refines it
      // after the turn (maybe_auto_title_after_turn treats fallback titles as
      // soft and upgrades them when the provider allows). Slash commands and
      // user renames are never clobbered.
      if (!ChatSendService.isCommandText(text)) {
        const currentTitle = useSessionsStore
          .getState()
          .sessions.find((s) => s.id === sessionId)?.title;
        if (isPlaceholderTitle(currentTitle)) {
          const snippet = deriveSnippetTitle(text);
          if (snippet) renameSession(sessionId, snippet);
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
        readyAttachments.length > 0
          ? readyAttachments.map(persistAttachment)
          : undefined;
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
      playSendChime();
      // Part 26 7.2: the dormant per-turn auto-route fetch is gone (AGENTS.md:
      // there is NO automatic turn rerouting — the backend loop never existed
      // and the opt-in flag could only ever be written '0'). Arena/Debate
      // remain the model-comparison surfaces; routing_evidence is read by the
      // Arena launcher hints.
      // Pass the FULL message history — generateAIResponse builds the new
      // messages state from this argument, so passing only `[userMsg]` would
      // overwrite the existing list with just two entries and wipe the prior
      // conversation from view and from localStorage.
      try {
        await generateAIResponse(nextMessages);
      } catch {
        // generateAIResponse releases the latch itself once the turn is
        // registered; this catch only guards pre-registration throws so a
        // bail can never wedge the double-Enter latch.
        releaseSendLatch();
      }
    },
    [
      sessionId,
      loadedSessionId,
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

  // Keep the retry ref pointed at the freshest `send` (assigned during render,
  // same pattern as messagesRef / modelForRequestRef above).
  sendRef.current = send;

  return { send, generateAIResponse };
}
