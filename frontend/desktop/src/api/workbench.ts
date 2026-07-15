/* Workbench API client — talks to backend /api/workbench/* endpoints.
 * CRUD/queue/plan helpers delegate to WorkbenchClient; streaming chat,
 * SSE reconnect, and plan-decision streams re-export from workbench/stream. */

import type {
  WorkbenchSession,
  WorkbenchAgentRegistry,
  WorkbenchCapabilities,
  WorkbenchBtwResult,
  WorkbenchEventHandlers,
  WorkbenchGuardMode,
} from '@/types/workbench';
import type { FileAttachment } from '@/types/chat';
import { workbenchClient } from './workbench/WorkbenchClient';

export interface CreateWorkbenchSessionParams {
  provider?: string;
  agentId?: string;
  guardMode?: WorkbenchGuardMode;
}

export async function setWorkbenchGuardMode(
  sessionId: string,
  guardMode: WorkbenchGuardMode
): Promise<WorkbenchSession> {
  return workbenchClient.setGuardMode(sessionId, guardMode);
}

export async function confirmWorkbenchMutation(
  token: string,
  handlers: WorkbenchEventHandlers
): Promise<void> {
  const res = await fetch('/api/workbench/mutations/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    handlers.onError?.({ message: (data.message as string) || `confirmWorkbenchMutation failed: ${res.status}` });
    return;
  }

  const data = (await res.json()) as Record<string, unknown>;
  handlers.onToolResult?.({
    id: token,
    content: JSON.stringify({ type: 'mutation_confirmation_result', result: data }, null, 2),
    isError: !!(data.blocked as boolean) || !!(data.error as boolean),
  });
  handlers.onDone?.();
}

export async function createWorkbenchSession(
  params: CreateWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  return workbenchClient.createSession(params);
}

export async function getWorkbenchSessions(): Promise<WorkbenchSession[]> {
  return workbenchClient.listSessions();
}

export async function getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.getSession(sessionId);
}

/* ── Streaming chat / SSE reconnect / plan decisions ─────────────────── */
export {
  type StreamWorkbenchChatParams,
  streamWorkbenchChat,
  streamWorkbenchReconnect,
  streamWorkbenchRevision,
  type PlanDecision,
  streamPlanDecision,
} from './workbench/stream';

export async function stopWorkbenchChat(sessionId: string): Promise<void> {
  return workbenchClient.stopChat(sessionId);
}

/* ── Mid-response queued messages ─────────────────────────────────────── */

/** A user message that was queued while the model was streaming. The
 *  chat loop drains the queue at the next iteration boundary and wraps
 *  each entry with <queued_message> tags so the model can distinguish
 *  the queued text from a fresh top-of-conversation prompt. */
export interface QueuedUserMessage {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: string;
  kind?: 'queue' | 'steer';
}

/** Submit a follow-up message that will be delivered to the model mid-
 *  response. The next time the chat loop's iteration boundary fires
 *  (after toolResults or after the model emits a text-only turn), the
 *  queued entries are drained and the model decides whether to act on
 *  them.
 *
 *  kind:
 *  - ``queue`` — ordinary follow-up
 *  - ``steer`` — mid-run course correction (priority + stronger prompt)
 */
export async function queueWorkbenchMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
  kind: 'queue' | 'steer' = 'queue',
): Promise<QueuedUserMessage> {
  return workbenchClient.queueMessage(sessionId, text, attachments, kind);
}

/** Mid-run steer — redirect August without stopping the current turn. */
export async function steerWorkbenchMessage(
  sessionId: string,
  text: string,
  attachments?: FileAttachment[],
): Promise<QueuedUserMessage> {
  return workbenchClient.steerMessage(sessionId, text, attachments);
}

/** Cancel a single queued message before the model receives it. */
export async function dequeueWorkbenchMessage(
  sessionId: string,
  messageId: string,
): Promise<void> {
  return workbenchClient.dequeueMessage(sessionId, messageId);
}

/** Clear the entire mid-response queue for a session. */
export async function clearQueuedWorkbenchMessages(
  sessionId: string,
): Promise<{ cleared: number }> {
  return workbenchClient.clearQueue(sessionId);
}

/** Reorder queued messages (drag reorder). `order` is message ids in desired order. */
export async function reorderQueuedWorkbenchMessages(
  sessionId: string,
  order: string[],
): Promise<QueuedUserMessage[]> {
  return workbenchClient.reorderQueue(sessionId, order);
}

/** Edit the text of a queued message before the model receives it. */
export async function updateQueuedWorkbenchMessage(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<QueuedUserMessage> {
  return workbenchClient.updateQueuedMessage(sessionId, messageId, text);
}

/** Hydrate the local queue state from the server (used on mount and
 *  after session switch). */
export async function getQueuedWorkbenchMessages(
  sessionId: string,
): Promise<QueuedUserMessage[]> {
  return workbenchClient.listQueue(sessionId);
}

export type DoctorCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  summary: string;
};

/** Setup doctor: backend, disk, MCP, OAuth readiness. */
export async function getWorkbenchDoctor(): Promise<DoctorReport> {
  return workbenchClient.doctor();
}

export async function approveWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.approvePlan(sessionId);
}

export async function rejectWorkbenchPlan(sessionId: string): Promise<WorkbenchSession> {
  return workbenchClient.rejectPlan(sessionId);
}

export interface ResetWorkbenchSessionParams {
  sessionId?: string;
  provider?: string;
  agentId?: string;
}

export async function resetWorkbenchSession(
  params: ResetWorkbenchSessionParams = {}
): Promise<WorkbenchSession> {
  const sid = params.sessionId ? encodeURIComponent(params.sessionId) : '';
  const res = await fetch(`/api/workbench/sessions/${sid}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      provider: params.provider || '',
      agentId: params.agentId || 'build',
    }),
  });
  if (!res.ok) throw new Error(`resetWorkbenchSession failed: ${res.status}`);
  return res.json() as Promise<WorkbenchSession>;
}

/** Delete a workbench session (cascades messages / timeline / usage in SQLite). */
export async function deleteWorkbenchSession(sessionId: string): Promise<void> {
  return workbenchClient.deleteSession(sessionId);
}

/** Rename a workbench session (sidebar title). */
export async function renameWorkbenchSession(
  sessionId: string,
  title: string,
): Promise<WorkbenchSession> {
  return workbenchClient.renameSession(sessionId, title);
}

/** Remove the last user turn (and following assistant/tool messages) on the server. */
export async function undoWorkbenchLastTurn(sessionId: string): Promise<{
  session: WorkbenchSession;
  removed: number;
  message?: string;
}> {
  return workbenchClient.undoLastTurn(sessionId);
}

/** Fork a workbench session (optional upToIndex = last source message to keep). */
export async function branchWorkbenchSession(
  sessionId: string,
  upToIndex?: number | null,
): Promise<WorkbenchSession> {
  return workbenchClient.branchSession(sessionId, upToIndex);
}

/** Force context compression (“Free up chat memory”). */
export async function compactWorkbenchSession(sessionId: string): Promise<{
  session: WorkbenchSession;
  underThreshold?: boolean;
  originalTokens?: number;
  compressedTokens?: number;
  compressedCount?: number;
  headCount?: number;
  tailCount?: number;
  message?: string;
}> {
  return workbenchClient.compactSession(sessionId);
}

export interface WorkbenchCheckpoint {
  id: string;
  sessionId?: string;
  createdAt?: string;
  label?: string;
  fileCount?: number;
  toolName?: string;
}

export async function listWorkbenchCheckpoints(
  sessionId: string,
): Promise<WorkbenchCheckpoint[]> {
  return workbenchClient.listCheckpoints(sessionId);
}

export async function restoreWorkbenchCheckpoint(
  sessionId: string,
  checkpointId: string,
): Promise<{ ok: boolean; message?: string; restored?: number; deleted?: number }> {
  return workbenchClient.restoreCheckpoint(sessionId, checkpointId) as Promise<{
    ok: boolean;
    message?: string;
    restored?: number;
    deleted?: number;
  }>;
}

export interface SessionAgentRow {
  taskId: string;
  agentId: string;
  goal: string;
  status: string;
  elapsed?: number;
  error?: string;
}

export async function listWorkbenchSessionAgents(sessionId: string): Promise<{
  agents: SessionAgentRow[];
  meta: {
    isolateSubagents?: boolean;
    lastCheckpointId?: string;
    lastCheckpointLabel?: string;
  };
}> {
  return workbenchClient.listSessionAgents(sessionId);
}

export async function setIsolateSubagents(
  sessionId: string,
  enabled: boolean,
): Promise<{ ok: boolean; isolateSubagents: boolean }> {
  return workbenchClient.setIsolateSubagents(sessionId, enabled);
}

export async function cancelAllSessionAgents(
  sessionId: string,
): Promise<{ ok: boolean; count: number; cancelled: string[] }> {
  return workbenchClient.cancelAllAgents(sessionId);
}

export async function terminateSessionAgent(
  taskId: string,
): Promise<{ status: string; taskId: string }> {
  return workbenchClient.terminateAgent(taskId);
}

export async function listWorkbenchAgents(activeAgentId = 'build'): Promise<WorkbenchAgentRegistry> {
  return workbenchClient.listAgents(activeAgentId);
}

export async function listWorkbenchCapabilities(): Promise<WorkbenchCapabilities> {
  return workbenchClient.listCapabilities();
}

export interface AnswerWorkbenchBtwParams {
  sessionId: string;
  question: string;
}

/** BTW uses the session's chat model on the server (same as the last chat turn). */
export async function answerWorkbenchBtw(
  params: AnswerWorkbenchBtwParams
): Promise<WorkbenchBtwResult> {
  const res = await fetch('/api/workbench/btw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: params.sessionId,
      question: params.question,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { detail?: string };
    throw new Error(
      (typeof detail.detail === 'string' ? detail.detail : null) ||
        `answerWorkbenchBtw failed: ${res.status}`,
    );
  }
  return res.json() as Promise<WorkbenchBtwResult>;
}

/* ── Brain orchestrator settings ──────────────────────────────────────── */

export interface BrainConfig {
  enabled: boolean;
  adaptivePolicy: boolean;
  failureLearning: boolean;
  graphMemory: boolean;
  agentJobs: boolean;
  hierarchicalAgents: boolean;
  adapterParallelTools: boolean;
  parallelReadTools: boolean;
  reviewLearnedGuidelines: boolean;
  maxAgentDepth: number;
  maxWorkbenchToolLoops: number;
}

export type BrainConfigSource = 'persisted' | 'session' | 'fallback';

export interface BrainConfigResponse {
  source: BrainConfigSource;
  config: BrainConfig;
  defaults: BrainConfig;
  sessionId?: string | null;
  session?: { id: string; task: string | null } | null;
}

export async function getBrainConfig(): Promise<BrainConfigResponse> {
  const res = await fetch('/api/brain/config');
  if (!res.ok) throw new Error(`getBrainConfig failed: ${res.status}`);
  return res.json() as Promise<BrainConfigResponse>;
}

export async function saveBrainConfig(updates: Partial<BrainConfig>): Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }> {
  const res = await fetch('/api/brain/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `saveBrainConfig failed: ${res.status}`);
  }
  return res.json() as Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }>;
}

export async function resetBrainConfig(): Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }> {
  const res = await fetch('/api/brain/config/reset', { method: 'POST' });
  if (!res.ok) throw new Error(`resetBrainConfig failed: ${res.status}`);
  return res.json() as Promise<{ ok: boolean; config: BrainConfig; defaults: BrainConfig }>;
}

export async function getBrainConfigFromSession(sessionId: string): Promise<BrainConfigResponse> {
  const res = await fetch(`/api/brain/config/from-session?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`getBrainConfigFromSession failed: ${res.status}`);
  return res.json() as Promise<BrainConfigResponse>;
}

/* ── Client re-export ─────────────────────────────────────────────────── */
/* Prefer `workbenchClient` at call sites; free functions keep stable names. */
export { WorkbenchClient, workbenchClient } from './workbench/WorkbenchClient';
export { WorkbenchHttpError } from './workbench/http';
