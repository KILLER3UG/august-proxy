/**
 * Wires makeStreamHandlers into the session stream store for one turn.
 * Used by startChatStream and reconnectChatStream so both paths share the
 * same setMessages / subagent / tool-progress / finishTurn adapters.
 */

import type { ChatMessage } from '@/types/chat';
import type { ChatTurnRecord } from '../chat-runtime';
import { chatRuntime } from '../chat-runtime';
import { makeStreamHandlers, type StreamHandlers } from '../makeStreamHandlers';
import { gitApi } from '@/api/git';
import { setSessionStatus } from '@/store/sessions';
import {
  applyUpdater,
  persistMessages,
  updateSessionStreamState,
} from './session-stream-store';
import { activeStreamControllers } from './active-stream-controllers';
import { appendBlockEvent } from './append-block-event';

export function bindTurnStreamHandlers(opts: {
  sessionId: string;
  assistantMsgId: string;
  initialMessages: ChatMessage[];
  turn: ChatTurnRecord;
}): StreamHandlers {
  const { sessionId, assistantMsgId, initialMessages, turn } = opts;

  return makeStreamHandlers({
    sessionId,
    assistantMsgId,
    initialMessages,
    setMessages: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextMsgs = applyUpdater(updater, prev.messages);
        persistMessages(sessionId, nextMsgs);
        return { messages: nextMsgs };
      });
    },
    persistMessages,
    setSessionStatus,
    setWorkbenchSession: (session) => {
      updateSessionStreamState(sessionId, (prev) => ({
        workbenchSession:
          typeof session === 'function' ? session(prev.workbenchSession) : session,
      }));
    },
    setSubagentPrompts: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextPrompts = applyUpdater(updater, prev.subagentPrompts);
        return { subagentPrompts: nextPrompts };
      });
    },
    setToolProgress: (updater) => {
      updateSessionStreamState(sessionId, prev => {
        const nextProgress = applyUpdater(updater, prev.toolProgress);
        return { toolProgress: nextProgress };
      });
    },
    setWorkbenchBtw: (btw) => {
      updateSessionStreamState(sessionId, () => ({ workbenchBtw: btw }));
    },
    isTurnVisible: () => true,
    finishTurn: (t, status) => {
      chatRuntime.finishTurn(t.turnId, status);
      activeStreamControllers.delete(sessionId);
    },
    turn,
    gitApi,
    streamUpdateIntervalMs: 24,
    appendBlockEvent,
  });
}
