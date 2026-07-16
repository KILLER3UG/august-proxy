/* ── usePlanTurn ──────────────────────────────────────────────────────── */
/* Streams plan accept / reject / revise turns with the same handler bundle */
/* as a normal composer message so the thread shows thinking, tools, text.  */

import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import {
  setSessionStatus,
  clearSessionStatus,
} from '@/store/sessions';
import {
  approveWorkbenchPlan,
  rejectWorkbenchPlan,
  streamPlanDecision,
  streamWorkbenchRevision,
  streamWorkbenchReconnect,
} from '@/api/workbench';
import type { WorkbenchSession } from '@/types/workbench';
import type { ChatMessage, ToolProgressEntry, WorkbenchBtwState } from '@/types/chat';
import type { WorkbenchGuardMode } from '@/components/chat/WorkbenchModeSelector';
import { gitApi } from '@/api/git';
import { chatRuntime, type ChatTurnRecord } from '../chat-runtime';
import {
  appendBlockEvent,
  activeStreamControllers,
} from '../chat-stream-manager';
import { makeStreamHandlers } from '../makeStreamHandlers';
import { persistMessages } from '../message-storage';
import type { SubagentPromptMap } from './useSessionStream';

const STREAM_UPDATE_INTERVAL_MS = 24;

type ToolProgressMap = Map<string, ReadonlyArray<ToolProgressEntry>>;

export interface UsePlanTurnOptions {
  sessionId: string | null;
  loadedSessionId: string | null;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  workbenchSession: WorkbenchSession | null;
  setWorkbenchSession: (
    session:
      | WorkbenchSession
      | null
      | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
  ) => void;
  setSubagentPrompts: Dispatch<SetStateAction<SubagentPromptMap>>;
  setToolProgress: Dispatch<SetStateAction<ToolProgressMap>>;
  setWorkbenchBtw: (
    result:
      | WorkbenchBtwState
      | null
      | ((prev: WorkbenchBtwState | null) => WorkbenchBtwState | null),
  ) => void;
  setWorkbenchMode: Dispatch<SetStateAction<WorkbenchGuardMode>>;
  isTurnVisible: (turnSessionId: string | null) => boolean;
  finishTurn: (turn: ChatTurnRecord, status?: 'done' | 'error' | 'aborted') => void;
  loadMessagesForSession: (sessionId: string | null) => ChatMessage[];
}

/**
 * Plan-banner actions: approve / reject / revise, each opening a streamed
 * model turn so the chat updates like a normal send.
 */
export function usePlanTurn(opts: UsePlanTurnOptions) {
  const {
    sessionId,
    loadedSessionId,
    messages,
    setMessages,
    workbenchSession,
    setWorkbenchSession,
    setSubagentPrompts,
    setToolProgress,
    setWorkbenchBtw,
    setWorkbenchMode,
    isTurnVisible,
    finishTurn,
    loadMessagesForSession,
  } = opts;

  /**
   * Shared streaming shell for plan banner callbacks. Starts a runtime turn,
   * builds makeStreamHandlers, runs the caller's stream* API, then reconnects
   * from sinceSeq when the backend returns one.
   */
  const streamPlanTurn = useCallback(
    async (
      run: (
        handlers: { onError?: (data: { message: string }) => void } & Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<unknown>,
      overrideMessages?: ChatMessage[],
      targetWorkbenchSessionId?: string,
    ) => {
      if (!sessionId) return;
      setSessionStatus(sessionId, 'working');
      const assistantMsgId = `a${Date.now()}`;
      const turn = chatRuntime.startTurn({
        sessionId,
        assistantMsgId,
        transport: 'none',
      });
      const abortController = turn.controller;
      activeStreamControllers.set(sessionId, abortController);
      const initialMsgs =
        overrideMessages ||
        (sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId));
      const { handlers, finalize } = makeStreamHandlers({
        sessionId,
        assistantMsgId,
        initialMessages: initialMsgs,
        setMessages,
        persistMessages,
        setSessionStatus,
        setWorkbenchSession,
        setSubagentPrompts,
        setToolProgress,
        setWorkbenchBtw,
        isTurnVisible,
        finishTurn,
        turn,
        gitApi,
        streamUpdateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
        initialMutationCount: workbenchSession?.mutationCount,
        appendBlockEvent,
      });
      // Keep the toast alongside the factory's ⚠️ stream-error block.
      const wrappedHandlers = {
        ...handlers,
        onError: (data: { message: string }) => {
          toast.error('Could not notify the model', { description: data.message });
          handlers.onError?.(data);
        },
      };
      try {
        chatRuntime.setTransport(turn.turnId, 'http');
        const startResult = await run(wrappedHandlers, abortController.signal);
        const wbSessionId =
          targetWorkbenchSessionId || workbenchSession?.id || sessionId;
        const resultWithSeq = startResult as { sinceSeq?: number } | null;
        if (resultWithSeq && Number.isFinite(resultWithSeq.sinceSeq)) {
          await streamWorkbenchReconnect(
            wbSessionId,
            wrappedHandlers,
            abortController.signal,
            resultWithSeq.sinceSeq,
          );
        }
        finalize(abortController.signal.aborted ? 'aborted' : 'done');
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          clearSessionStatus(sessionId);
          finalize('aborted');
          return;
        }
        console.error('[streamPlanTurn] error:', e);
        finalize('error');
      } finally {
        activeStreamControllers.delete(sessionId);
      }
    },
    [
      sessionId,
      loadedSessionId,
      messages,
      setMessages,
      setWorkbenchSession,
      setSubagentPrompts,
      setToolProgress,
      setWorkbenchBtw,
      isTurnVisible,
      finishTurn,
      loadMessagesForSession,
      workbenchSession?.id,
      workbenchSession?.mutationCount,
    ],
  );

  /** User revises a pending plan: append feedback, clear plan, stream revision. */
  const handlePlanRevision = useCallback(
    async (feedback: string) => {
      if (!workbenchSession || !sessionId) return;
      const wbSessionId = workbenchSession.id;
      try {
        const userMsg: ChatMessage = {
          id: `m${Date.now()}`,
          role: 'user',
          content: feedback,
          timestamp: new Date().toISOString(),
        };
        const currentMessages =
          sessionId === loadedSessionId ? messages : loadMessagesForSession(sessionId);
        const nextMessages = [...currentMessages, userMsg];
        setMessages(nextMessages);
        persistMessages(sessionId, nextMessages);

        // Reject/clear the plan so the banner yields to composer + working state.
        try {
          const updated = await rejectWorkbenchPlan(wbSessionId);
          setWorkbenchSession(updated);
        } catch (err) {
          console.warn('Failed to reject plan before revision:', err);
          setWorkbenchSession((prev: WorkbenchSession | null) =>
            prev ? { ...prev, plan: null } : null,
          );
        }

        await streamPlanTurn(
          (handlers, signal) =>
            streamWorkbenchRevision(wbSessionId, feedback, handlers, signal),
          nextMessages,
          wbSessionId,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Could not send revision', { description: message });
      }
    },
    [
      workbenchSession,
      sessionId,
      loadedSessionId,
      messages,
      loadMessagesForSession,
      setMessages,
      setWorkbenchSession,
      streamPlanTurn,
    ],
  );

  /** Accept plan without implementing — model is notified and stays gated. */
  const handlePlanAccept = useCallback(() => {
    void (async () => {
      if (!workbenchSession) return;
      try {
        // Approve API returns {status}, not a full session — update locally.
        await approveWorkbenchPlan(workbenchSession.id);
        setWorkbenchSession((prev) =>
          prev
            ? {
                ...prev,
                approved: true,
                planApproved: true,
                approvedAt: new Date().toISOString(),
              }
            : null,
        );
        // Accepted but do not implement — stream the decision so the model replies.
        await streamPlanTurn((handlers, signal) =>
          streamPlanDecision(workbenchSession.id, 'accept', handlers, signal),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Could not approve Workbench plan', { description: message });
      }
    })();
  }, [workbenchSession, setWorkbenchSession, streamPlanTurn]);

  /** Accept plan and switch to Full access so the model may implement. */
  const handlePlanAcceptAndImplement = useCallback(() => {
    void (async () => {
      if (!workbenchSession) return;
      try {
        await approveWorkbenchPlan(workbenchSession.id);
        setWorkbenchSession((prev) =>
          prev
            ? {
                ...prev,
                approved: true,
                planApproved: true,
                approvedAt: new Date().toISOString(),
              }
            : null,
        );
        setWorkbenchMode('full');
        await streamPlanTurn((handlers, signal) =>
          streamPlanDecision(
            workbenchSession.id,
            'accept-and-implement',
            handlers,
            signal,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Could not approve Workbench plan', { description: message });
      }
    })();
  }, [
    workbenchSession,
    setWorkbenchSession,
    setWorkbenchMode,
    streamPlanTurn,
  ]);

  /** Reject plan and stream the decision so the model acknowledges. */
  const handlePlanReject = useCallback(() => {
    void (async () => {
      if (!workbenchSession) return;
      try {
        await rejectWorkbenchPlan(workbenchSession.id);
        setWorkbenchSession((prev) =>
          prev
            ? {
                ...prev,
                plan: null,
                approved: false,
                planApproved: false,
                approvedAt: null,
              }
            : null,
        );
        await streamPlanTurn((handlers, signal) =>
          streamPlanDecision(workbenchSession.id, 'reject', handlers, signal),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Could not reject Workbench plan', { description: message });
      }
    })();
  }, [workbenchSession, setWorkbenchSession, streamPlanTurn]);

  /**
   * After Accept/Reject on the mutation banner, the backend already started a
   * continuation turn and returned `sinceSeq`. Reattach SSE so the chat
   * keeps streaming instead of looking finished/stopped.
   */
  const handleMutationContinued = useCallback(
    async (sinceSeq: number) => {
      if (!sessionId || !Number.isFinite(sinceSeq)) return;
      const wbId = workbenchSession?.id;
      if (!wbId) return;
      try {
        await streamPlanTurn(async () => ({ sinceSeq }), undefined, wbId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        toast.error('Could not continue after approval', { description: message });
      }
    },
    [sessionId, workbenchSession?.id, streamPlanTurn],
  );

  return {
    streamPlanTurn,
    handlePlanRevision,
    handlePlanAccept,
    handlePlanAcceptAndImplement,
    handlePlanReject,
    handleMutationContinued,
  };
}
