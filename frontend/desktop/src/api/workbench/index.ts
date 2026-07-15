/** Public barrel for WorkbenchClient, HTTP helpers, and streaming chat. */
export {
  WorkbenchClient,
  workbenchClient,
  type CreateSessionParams,
  type QueuedUserMessage,
  type DoctorCheck,
  type DoctorReport,
  type SessionAgentRow,
  type WorkbenchCheckpoint,
} from './WorkbenchClient';
export { WorkbenchHttpError, wbFetch, jsonInit } from './http';
export {
  type StreamWorkbenchChatParams,
  streamWorkbenchChat,
  streamWorkbenchReconnect,
  streamWorkbenchRevision,
  type PlanDecision,
  streamPlanDecision,
} from './stream';
export { dispatchWorkbenchEvent, validateWorkbenchEvent } from './streamEvents';
