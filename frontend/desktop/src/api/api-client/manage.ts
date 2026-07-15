/* Settings/management REST helpers and legacy /api/august/* wrappers. */

import { api } from '../client';
import type { AgentEntry, StoredSession } from './traffic';

export interface AugustSnapshot {
  sessions?: unknown[];
  config?: {
    security?: {
      allowedRoots: string[];
      filesystemScope: 'allowlist' | 'root';
      postObservationScreenshot?: boolean;
    };
  };
  providers?: unknown[];
  models?: unknown[];
  tools?: Array<{ name?: string; toolset?: string; description?: string }>;
  memory?: unknown;
  agents?: unknown[];
  skills?: unknown[];
}

export function getAugustSnapshot(): Promise<AugustSnapshot> {
  return api.get<AugustSnapshot>('/api/manage/snapshot');
}

// Sessions (uses /api/sessions router)
export function listManageSessions(): Promise<StoredSession[]> {
  return api.get<{ sessions: StoredSession[] }>('/api/sessions').then((r) => r.sessions ?? []);
}
export function createManageSession(params?: {
  provider?: string;
  agentId?: string;
  guardMode?: string;
}): Promise<unknown> {
  return api.post('/api/sessions', params || {});
}
export function deleteManageSession(id: string): Promise<unknown> {
  return api.delete(`/api/sessions/${encodeURIComponent(id)}`);
}

// Providers (uses /api/providers router)
export function listManageProviders(): Promise<unknown[]> {
  return api.get('/api/providers');
}
export function createManageProvider(body: {
  name: string;
  baseUrl: string;
  apiFormat?: string;
  apiKey?: string;
  enabled?: boolean;
}): Promise<unknown> {
  return api.post('/api/providers', body);
}

// Agents (uses /api/agents router)
export function listManageAgents(): Promise<AgentEntry[]> {
  return api.get<{ agents: AgentEntry[] }>('/api/agents').then((r) => r.agents ?? []);
}
export function createManageAgent(body: {
  name: string;
  parentId?: string;
  permissions?: string[];
  toolsets?: string[];
  model?: string;
  provider?: string;
}): Promise<unknown> {
  return api.post('/api/agents', body);
}
export function deleteManageAgent(id: string): Promise<unknown> {
  return api.delete(`/api/agents/${encodeURIComponent(id)}`);
}

// Aliases (uses /api/manage/aliases router)
export function listManageAliases(): Promise<Array<{ alias: string; targetModel: string }>> {
  return api.get('/api/manage/aliases');
}
export function createManageAlias(body: {
  alias: string;
  targetModel: string;
  targetProvider?: string;
}): Promise<unknown> {
  return api.post('/api/manage/aliases', body);
}
export function deleteManageAlias(alias: string): Promise<unknown> {
  return api.delete(`/api/manage/aliases/${encodeURIComponent(alias)}`);
}

// Memory facts (uses /api/memory/facts router)
export interface MemoryFact {
  key: string;
  value: unknown;
  category?: string;
}

export function listManageMemory(category?: string): Promise<MemoryFact[]> {
  return api
    .get<{ facts: MemoryFact[] }>(
      `/api/memory/facts${category ? `?category=${encodeURIComponent(category)}` : ''}`,
    )
    .then((r) => r.facts ?? []);
}
export function createManageMemoryFact(body: {
  key: string;
  value: unknown;
  category?: string;
}): Promise<unknown> {
  return api.post('/api/memory/facts', body);
}
export function deleteManageMemoryFact(key: string): Promise<unknown> {
  return api.delete(`/api/memory/facts/${encodeURIComponent(key)}`);
}

// Settings (uses /api/manage/settings router)
export function updateManageSettings(
  updates: Record<string, unknown>,
): Promise<{ updated: string[] }> {
  return api.put('/api/manage/settings', { updates });
}

// Snapshot (uses /api/manage/snapshot router)
export function getManageSnapshot(): Promise<unknown> {
  return api.get('/api/manage/snapshot');
}

/* Legacy /api/august/* wrappers (deprecated, kept for backward compat) */

export function manageAugustSessions(payload: {
  action: 'list' | 'create' | 'update' | 'rename' | 'archive' | 'restore' | 'delete';
  id?: string;
  title?: string;
  updates?: Record<string, unknown>;
}): Promise<{ ok: boolean; session?: unknown; sessions?: unknown[] }> {
  return api.post('/api/august/sessions/manage', payload);
}

export function updateAugustSetting(payload: {
  keyPath: string;
  value: unknown;
}): Promise<{ ok: boolean; keyPath?: string; value?: unknown; rollbackId?: string }> {
  return api.post('/api/august/settings/update', payload);
}

export function selectAugustModel(payload: {
  model: string;
  provider?: string;
}): Promise<{ ok: boolean; profile?: string; model?: string; provider?: string }> {
  return api.post('/api/august/models/select', payload);
}

export function manageAugustProviders(payload: {
  action: 'upsert' | 'delete';
  provider?: Record<string, unknown>;
  id?: string;
}): Promise<{ ok: boolean; provider?: unknown; id?: string; deleted?: boolean }> {
  return api.post('/api/august/providers/manage', payload);
}

export function manageAugustAgents(payload: {
  action: 'upsert' | 'delete';
  agent?: Record<string, unknown>;
  id?: string;
}): Promise<{ ok: boolean; agent?: unknown; id?: string; deleted?: boolean }> {
  return api.post('/api/august/agents/manage', payload);
}

export function manageAugustMemory(payload: {
  action: 'set' | 'upsert' | 'delete' | 'forget';
  key: string;
  value?: unknown;
  category?: string;
  ttl_days?: number;
}): Promise<{ ok: boolean; key?: string; value?: unknown }> {
  return api.post('/api/august/memory/manage', payload);
}

export function undoAugustRollback(id: string): Promise<{ ok: boolean; entry?: unknown }> {
  return api.post(`/api/august/rollback/${encodeURIComponent(id)}/undo`, {});
}

export function manageAugustAliases(payload: {
  action: 'list' | 'upsert' | 'delete';
  alias?: string;
  targetModel?: string;
  targetProvider?: string;
}): Promise<{
  ok: boolean;
  aliases?: Array<{ alias: string; targetModel: string }>;
  alias?: string;
  deleted?: boolean;
}> {
  return api.post('/api/august/aliases/manage', payload);
}

/* Tool management (MCP + plugins) */

export function manageAugustTools(payload: {
  action: 'list' | 'upsert' | 'delete';
  kind?: 'mcp' | 'plugin';
  name?: string;
  config?: Record<string, unknown>;
}): Promise<{ ok: boolean; tools?: unknown; tool?: unknown; name?: string; deleted?: boolean }> {
  return api.post('/api/august/tools/manage', payload);
}

/* Computer-use app policy */

export interface AppPolicy {
  app: string;
  policy: 'allow' | 'ask' | 'deny';
}

export function setAugustAppPolicy(
  policy: AppPolicy,
): Promise<{ ok: boolean; app: string; policy: string }> {
  return api.post('/api/august/computer/app-policy', { action: 'set', ...policy });
}

export function deleteAugustAppPolicy(app: string): Promise<{ ok: boolean; app: string }> {
  return api.post('/api/august/computer/app-policy', { action: 'delete', app });
}

export function listAugustAppPolicies(): Promise<{
  ok: boolean;
  policies: Record<string, 'allow' | 'ask' | 'deny'>;
}> {
  return api.post('/api/august/computer/app-policy', { action: 'list' });
}

/* UI events */

export interface UiEvent {
  id: string;
  type: 'august:ui-action';
  action: string;
  target: string | null;
  payload?: Record<string, unknown>;
  at: string;
}

export function controlAugustUi(payload: {
  action: string;
  target: string;
  payload?: Record<string, unknown>;
}): Promise<{ ok: boolean; event: UiEvent }> {
  return api.post('/api/august/ui-action', payload);
}

export function subscribeUiEvents(since?: string): Promise<{ ok: boolean; events: UiEvent[] }> {
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  return api.get(`/api/august/ui-events${q}`);
}
