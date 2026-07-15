/**
 * Public entry for chat streaming: per-session store, turn start/stop, and
 * durable SSE subscription. Implementation lives under `./stream/*`.
 *
 * Consumers (ChatThread, useChatSend, useSessionStream) import from this
 * path so the split stays internal.
 */

export type {
  SessionStreamState,
  ChatMessage,
  MessageBlock,
  SubagentBlockState,
  ToolProgressEntry,
  WorkbenchBtwState,
} from './stream';

export {
  useSessionStreamStore,
  $sessionStreamStates,
  loadMessagesForSession,
  getOrInitSessionStreamState,
  updateSessionStreamState,
  appendBlockEvent,
  applySubagentEvent,
  activeStreamControllers,
  isSessionStreaming,
  startChatStream,
  stopChatStream,
  reconnectChatStream,
  ensureSessionSubscriber,
  detachSessionSubscriber,
  getSessionSubscriberLastSeq,
  syncActiveStreams,
  registerStreamResync,
} from './stream';
