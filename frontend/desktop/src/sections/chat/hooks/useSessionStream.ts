/* ── useSessionStream ──────────────────────────────────────────────────── */
/* React hook facade over the per-session stream store (OOP controller).  */

import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage, ToolProgressEntry } from '@/types/chat';
import type { WorkbenchSession } from '@/types/workbench';
import {
  $sessionStreamStates,
  getOrInitSessionStreamState,
  updateSessionStreamState,
  type SessionStreamState,
} from '../chat-stream-manager';
import { persistMessages } from '../message-storage';

export type SubagentPromptMap = Map<
  string,
  {
    content: string;
    systemPrompt: string;
    userMessage: string;
    tokens: number;
    subagentId?: string;
    jobId?: string;
  }
>;

/**
 * Controller-style access to one session's live stream state.
 * Keeps ChatThread free of store subscription boilerplate.
 */
export class SessionStreamController {
  constructor(private readonly sessionId: string | null) {}

  get state(): SessionStreamState {
    return getOrInitSessionStreamState(this.sessionId);
  }

  setMessages(updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])): void {
    if (!this.sessionId) return;
    updateSessionStreamState(this.sessionId, (prev) => {
      const next = typeof updater === 'function' ? updater(prev.messages) : updater;
      persistMessages(this.sessionId, next);
      return { messages: next };
    });
  }

  setSubagentPrompts(
    updater: SubagentPromptMap | ((prev: SubagentPromptMap) => SubagentPromptMap),
  ): void {
    if (!this.sessionId) return;
    updateSessionStreamState(this.sessionId, (prev) => {
      const next =
        typeof updater === 'function' ? updater(prev.subagentPrompts) : updater;
      return { subagentPrompts: next };
    });
  }

  setToolProgress(
    updater:
      | Map<string, ReadonlyArray<ToolProgressEntry>>
      | ((
          prev: Map<string, ReadonlyArray<ToolProgressEntry>>,
        ) => Map<string, ReadonlyArray<ToolProgressEntry>>),
  ): void {
    if (!this.sessionId) return;
    updateSessionStreamState(this.sessionId, (prev) => {
      const next =
        typeof updater === 'function' ? updater(prev.toolProgress) : updater;
      return { toolProgress: next };
    });
  }

  setWorkbenchSession(
    session:
      | WorkbenchSession
      | null
      | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
  ): void {
    if (!this.sessionId) return;
    updateSessionStreamState(this.sessionId, (prev) => ({
      workbenchSession:
        typeof session === 'function' ? session(prev.workbenchSession) : session,
    }));
  }

  subscribe(listener: (state: SessionStreamState) => void): () => void {
    let last = getOrInitSessionStreamState(this.sessionId);
    listener(last);
    return $sessionStreamStates.subscribe((states) => {
      const next =
        states[this.sessionId || ''] || getOrInitSessionStreamState(this.sessionId);
      if (next !== last) {
        last = next;
        listener(next);
      }
    });
  }
}

export function useSessionStream(sessionId: string | null) {
  const [streamState, setStreamState] = useState(() =>
    getOrInitSessionStreamState(sessionId),
  );

  useEffect(() => {
    const controller = new SessionStreamController(sessionId);
    return controller.subscribe(setStreamState);
  }, [sessionId]);

  const controller = useCallback(
    () => new SessionStreamController(sessionId),
    [sessionId],
  );

  const setMessages = useCallback(
    (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
      new SessionStreamController(sessionId).setMessages(updater);
    },
    [sessionId],
  );

  const setSubagentPrompts = useCallback(
    (updater: SubagentPromptMap | ((prev: SubagentPromptMap) => SubagentPromptMap)) => {
      new SessionStreamController(sessionId).setSubagentPrompts(updater);
    },
    [sessionId],
  );

  const setToolProgress = useCallback(
    (
      updater:
        | Map<string, ReadonlyArray<ToolProgressEntry>>
        | ((
            prev: Map<string, ReadonlyArray<ToolProgressEntry>>,
          ) => Map<string, ReadonlyArray<ToolProgressEntry>>),
    ) => {
      new SessionStreamController(sessionId).setToolProgress(updater);
    },
    [sessionId],
  );

  const setWorkbenchSession = useCallback(
    (
      session:
        | WorkbenchSession
        | null
        | ((prev: WorkbenchSession | null) => WorkbenchSession | null),
    ) => {
      new SessionStreamController(sessionId).setWorkbenchSession(session);
    },
    [sessionId],
  );

  return {
    streamState,
    messages: streamState.messages,
    subagentPrompts: streamState.subagentPrompts,
    subagentBlocks: streamState.subagentBlocks || new Map(),
    toolProgress: streamState.toolProgress,
    workbenchSession: streamState.workbenchSession,
    workbenchBtw: streamState.workbenchBtw,
    setMessages,
    setSubagentPrompts,
    setToolProgress,
    setWorkbenchSession,
    controller,
  };
}
