/**
 * Chat stream package — session store, per-turn start/stop, durable SSE
 * subscriber, and block reducers. Prefer importing from this barrel or from
 * `../chat-stream-manager` (stable public path for ChatThread / hooks).
 */

export type {
  SessionStreamState,
  ChatMessage,
  MessageBlock,
  SubagentBlockState,
  ToolProgressEntry,
  WorkbenchBtwState,
} from './session-stream-store';

export {
  useSessionStreamStore,
  $sessionStreamStates,
  loadMessagesForSession,
  persistMessages,
  getOrInitSessionStreamState,
  updateSessionStreamState,
  applyUpdater,
} from './session-stream-store';

export { appendBlockEvent } from './append-block-event';

export {
  applySubagentEvent,
  makeSubagentEventHandlers,
  type SubagentStreamEvent,
} from './apply-subagent-event';

export {
  activeStreamControllers,
  isSessionStreaming,
} from './active-stream-controllers';

export {
  startChatStream,
  stopChatStream,
  reconnectChatStream,
} from './start-stop-stream';

export {
  ensureSessionSubscriber,
  detachSessionSubscriber,
  getSessionSubscriberLastSeq,
  hasSessionSubscriber,
  syncActiveStreams,
  registerStreamResync,
} from './session-subscriber';

export {
  resolveUiSessionId,
  resolveWorkbenchSessionId,
} from './session-id-map';