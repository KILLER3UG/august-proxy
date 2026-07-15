/* ── WorkbenchClient ──────────────────────────────────────────────────── */
/* Domain client for /api/workbench/* — sessions, chat, queue, grants,    */
/* agents, sandbox, and doctor. Free functions in workbench.ts delegate   */
/* here so call sites can keep stable import names.                       */

import type {
  WorkbenchSession,
  WorkbenchAgentRegistry,
  WorkbenchCapabilities,
  WorkbenchGuardMode,
} from '@/types/workbench';
import type { FileAttachment } from '@/types/chat';
import { wbFetch, jsonInit } from './http';

export type CreateSessionParams = {
  provider?: string;
  agentId?: string;
  guardMode?: WorkbenchGuardMode;
};

export type QueuedUserMessage = {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: string;
  kind?: 'queue' | 'steer';
};

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

export type SessionAgentRow = {
  taskId: string;
  agentId: string;
  goal: string;
  status: string;
  elapsed?: number;
  error?: string;
};

export type WorkbenchCheckpoint = {
  id: string;
  label?: string;
  createdAt?: string;
  fileCount?: number;
};

/**
 * Single entry-point for workbench backend operations.
 * Prefer this class (or the `workbenchClient` singleton) at call sites.
 */
export class WorkbenchClient {
  /* ── Sessions ──────────────────────────────────────────────────── */

  async createSession(params: CreateSessionParams = {}): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      '/api/workbench/session',
      jsonInit('POST', {
        provider: params.provider || '',
        agentId: params.agentId || 'build',
        guardMode: params.guardMode,
      }),
    );
  }

  async listSessions(): Promise<WorkbenchSession[]> {
    const data = await wbFetch<{ sessions?: WorkbenchSession[] } | WorkbenchSession[]>(
      '/api/workbench/sessions',
    );
    return (Array.isArray(data) ? data : data.sessions) || [];
  }

  async getSession(sessionId: string): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      `/api/workbench/session?sessionId=${encodeURIComponent(sessionId)}`,
    );
  }

  async setGuardMode(
    sessionId: string,
    guardMode: WorkbenchGuardMode,
  ): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      '/api/workbench/guard-mode',
      jsonInit('POST', { sessionId, guardMode }),
    );
  }

  async renameSession(sessionId: string, title: string): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/title`,
      jsonInit('PATCH', { title }),
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await wbFetch<void>(
        `/api/workbench/sessions/${encodeURIComponent(sessionId)}`,
        jsonInit('DELETE'),
      );
    } catch (e) {
      // 404 = already gone
      if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 404) {
        return;
      }
      throw e;
    }
  }

  async undoLastTurn(sessionId: string) {
    return wbFetch<{ session: WorkbenchSession; removed: number; message?: string }>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/undo-last-turn`,
      jsonInit('POST'),
    );
  }

  async branchSession(
    sessionId: string,
    upToIndex?: number | null,
  ): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/branch`,
      jsonInit('POST', upToIndex == null ? {} : { upToIndex }),
    );
  }

  async compactSession(sessionId: string) {
    return wbFetch<{
      session: WorkbenchSession;
      underThreshold?: boolean;
      originalTokens?: number;
      compressedTokens?: number;
      message?: string;
    }>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/compact`,
      jsonInit('POST'),
    );
  }

  /* ── Chat control ──────────────────────────────────────────────── */

  async stopChat(sessionId: string): Promise<void> {
    await wbFetch<void>('/api/workbench/chat/stop', jsonInit('POST', { sessionId }));
  }

  /* ── Queue / steer ─────────────────────────────────────────────── */

  async queueMessage(
    sessionId: string,
    text: string,
    attachments?: FileAttachment[],
    kind: 'queue' | 'steer' = 'queue',
  ): Promise<QueuedUserMessage> {
    return wbFetch<QueuedUserMessage>(
      '/api/workbench/chat/queue',
      jsonInit('POST', {
        sessionId,
        text,
        attachments: attachments ?? [],
        kind,
      }),
    );
  }

  async steerMessage(
    sessionId: string,
    text: string,
    attachments?: FileAttachment[],
  ): Promise<QueuedUserMessage> {
    return this.queueMessage(sessionId, text, attachments, 'steer');
  }

  async dequeueMessage(sessionId: string, messageId: string): Promise<void> {
    await wbFetch<void>(
      `/api/workbench/chat/queue/${encodeURIComponent(messageId)}?sessionId=${encodeURIComponent(sessionId)}`,
      jsonInit('DELETE'),
    );
  }

  async clearQueue(sessionId: string): Promise<{ cleared: number }> {
    return wbFetch<{ cleared: number }>(
      `/api/workbench/chat/queue?sessionId=${encodeURIComponent(sessionId)}`,
      jsonInit('DELETE'),
    );
  }

  async reorderQueue(sessionId: string, order: string[]): Promise<QueuedUserMessage[]> {
    const data = await wbFetch<{ messages?: QueuedUserMessage[] }>(
      '/api/workbench/chat/queue',
      jsonInit('PATCH', { sessionId, order }),
    );
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  async updateQueuedMessage(
    sessionId: string,
    messageId: string,
    text: string,
  ): Promise<QueuedUserMessage> {
    return wbFetch<QueuedUserMessage>(
      `/api/workbench/chat/queue/${encodeURIComponent(messageId)}`,
      jsonInit('PATCH', { sessionId, text }),
    );
  }

  async listQueue(sessionId: string): Promise<QueuedUserMessage[]> {
    const data = await wbFetch<{ messages?: QueuedUserMessage[] }>(
      `/api/workbench/chat/queue?sessionId=${encodeURIComponent(sessionId)}`,
    );
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  /* ── Plan ──────────────────────────────────────────────────────── */

  async approvePlan(sessionId: string): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      '/api/workbench/plan/approve',
      jsonInit('POST', { sessionId }),
    );
  }

  async rejectPlan(sessionId: string): Promise<WorkbenchSession> {
    return wbFetch<WorkbenchSession>(
      '/api/workbench/plan/reject',
      jsonInit('POST', { sessionId }),
    );
  }

  /* ── Agents / isolation ────────────────────────────────────────── */

  async listSessionAgents(sessionId: string): Promise<{
    agents: SessionAgentRow[];
    meta: {
      isolateSubagents?: boolean;
      lastCheckpointId?: string;
      lastCheckpointLabel?: string;
    };
  }> {
    return wbFetch(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/agents`,
    );
  }

  async setIsolateSubagents(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; isolateSubagents: boolean }> {
    return wbFetch(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/isolate-subagents`,
      jsonInit('POST', { enabled }),
    );
  }

  async cancelAllAgents(
    sessionId: string,
  ): Promise<{ ok: boolean; count: number; cancelled: string[] }> {
    return wbFetch(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/agents/cancel-all`,
      jsonInit('POST'),
    );
  }

  async terminateAgent(taskId: string): Promise<{ status: string; taskId: string }> {
    return wbFetch(
      `/api/subagents/${encodeURIComponent(taskId)}/terminate`,
      jsonInit('POST'),
    );
  }

  /* ── Checkpoints ───────────────────────────────────────────────── */

  async listCheckpoints(sessionId: string): Promise<WorkbenchCheckpoint[]> {
    const data = await wbFetch<{ checkpoints?: WorkbenchCheckpoint[] }>(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
    );
    return data.checkpoints ?? [];
  }

  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): Promise<{ ok?: boolean; message?: string }> {
    return wbFetch(
      `/api/workbench/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
      jsonInit('POST'),
    );
  }

  /* ── Grants / doctor / sandbox / registry ───────────────────────── */

  async listToolGrants() {
    return wbFetch<{ workspaces: Array<{ workspacePath: string; grants: unknown[] }> }>(
      '/api/workbench/tool-grants',
    );
  }

  async revokeToolGrant(workspacePath: string, key: string) {
    return wbFetch(
      '/api/workbench/tool-grants',
      jsonInit('DELETE', { workspacePath, key }),
    );
  }

  async doctor(): Promise<DoctorReport> {
    return wbFetch<DoctorReport>('/api/workbench/doctor');
  }

  async runPythonSandbox(body: {
    code: string;
    cwd?: string;
    timeoutMs?: number;
  }) {
    return wbFetch<{
      ok: boolean;
      stdout?: string;
      stderr?: string;
      error?: string | null;
      elapsedMs?: number;
      cwd?: string;
    }>('/api/workbench/sandbox/python', jsonInit('POST', body));
  }

  async skillsHub() {
    return wbFetch<{ entries: unknown[] }>('/api/workbench/skills/hub');
  }

  async listAgents(activeAgentId = 'build'): Promise<WorkbenchAgentRegistry> {
    return wbFetch(
      `/api/workbench/agents?active=${encodeURIComponent(activeAgentId)}`,
    );
  }

  async listCapabilities(): Promise<WorkbenchCapabilities> {
    return wbFetch('/api/workbench/capabilities');
  }
}

/** Process-wide singleton — prefer this over constructing new clients. */
export const workbenchClient = new WorkbenchClient();
