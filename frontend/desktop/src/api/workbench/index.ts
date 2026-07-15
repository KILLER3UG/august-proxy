/** Public barrel for WorkbenchClient and HTTP helpers. */
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
