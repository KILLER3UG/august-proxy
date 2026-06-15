/* ── Backend UI API helpers ────────────────────────────────────────── */
/* Typed wrappers for the /ui/* monitoring & management endpoints.
 * All shapes mirror what backend/lib/logger.js and the route handlers
 * in backend/index.js actually return — do not trust the legacy mock
 * types. Secrets are redacted server-side; we never display raw keys. */

import { api } from './client';

/* ── Shared shapes (from backend/lib/logger.js) ── */

export interface RequestEntry {
  /** Always present from requestLog. */
  reqId: string;
  clientType: string;
  endpoint: string;
  model: string;
  status: 'success' | 'completed' | 'error' | string;
  durationMs: number;
  error?: string | null;
  /** logger stores time as locale string + iso date + epoch. */
  time?: string;
  date?: string;
  timestamp?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  requestType?: string;
}

export interface PendingRequest {
  reqId: string;
  clientType: string;
  endpoint: string;
  model: string;
  elapsedMs: number;
}

export interface RequestsResponse {
  pending: PendingRequest[];
  completed: RequestEntry[];
}

export interface ProfileStat {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export interface StatsResponse {
  totalRequests: number;
  completedRequests: number;
  errorRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedInputCost: number;
  estimatedOutputCost: number;
  estimatedTotalCost: number;
  avgDurationMs: number;
  pendingRequests: number;
  mostUsedModel: string | null;
  mostUsedCount: number;
  modelBreakdown: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  profileStats: Record<string, ProfileStat>;
}

export interface ActivityEntry {
  time: string;
  type: string;
  detail: string;
}

export interface RequestDetailEntry {
  reqId: string;
  date?: string;
  status?: string;
  requestBody?: string | object;
  responseBody?: string | object;
  thinking?: unknown;
  toolCalls?: unknown;
  finishReason?: string;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  requestType?: string;
}

/* Conversations are grouped by clientType. */
export type ConversationsResponse = Record<string, Array<RequestEntry & {
  details: {
    messages: unknown;
    response: unknown;
    thinking: unknown;
    toolCalls: unknown;
    finishReason?: string;
    error?: string | null;
  } | null;
}>>;

/* ── Session store shapes (backend/services/storage/session-store.js) ── */
export interface StoredSession {
  id: string;
  status?: string;
  agent_type?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SessionsResponse {
  sessions: StoredSession[];
  error?: string;
}

/* ── Agent registry (backend/services/tools/agent-registry.js) ── */
export interface AgentEntry {
  id: string;
  name?: string;
  role?: string;
  mode?: string;
  goal?: string;
  scope?: string;
  parentAgent?: string;
  permissions?: Record<string, unknown>;
  inheritedPermissions?: string[];
  approvalPolicy?: string;
  team?: boolean;
}

/* ── Automation jobs (backend/services/workbench/automation-jobs.js) ── */
export interface AutomationJob {
  id: string;
  name?: string;
  type?: string;
  schedule?: string;
  task?: string;
  command?: string;
  cwd?: string;
  agent?: string;
  enabled?: boolean;
  approved?: boolean;
  approvalRequired?: boolean;
  timeoutMs?: number;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastResult?: unknown;
}

export interface AutomationListResponse {
  jobs?: AutomationJob[];
  job?: AutomationJob;
}

/* ── Terminal (backend/services/workbench/terminal-service.js) ── */
export interface TerminalSession {
  id: string;
  title?: string;
  cwd?: string;
  command?: string;
  status?: string;
  createdAt?: string;
}

export interface TerminalApproval {
  requestId: string;
  id?: string;
  type?: string;
  command?: string;
  cwd?: string;
  inputPreview?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
}

export interface TerminalSessionsResponse {
  sessions: TerminalSession[];
  approvals: TerminalApproval[];
}

/* ── Models catalog (backend/services/catalog/model-catalog.js) ── */
export interface CatalogModel {
  id: string;
  provider: string;
  aliases?: string[];
  capabilities?: string[];
}

export interface ModelAlias {
  alias: string;
  resolvesTo: string;
  provider: string;
}

export interface ModelCostEstimate {
  model: string;
  cost: number;
  error?: string;
}

/* ── Host agent ── */
export interface HostAgentStatus {
  status: string;
}

/* ── Helpers ── */

export type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'year';

export function getRequests(period: Period = 'all'): Promise<RequestsResponse> {
  return api.get<RequestsResponse>(`/ui/requests?period=${period}`);
}

export function getStats(period: Period = 'all'): Promise<StatsResponse> {
  return api.get<StatsResponse>(`/ui/stats?period=${period}`);
}

export function getActivity(): Promise<ActivityEntry[]> {
  return api.get<ActivityEntry[]>('/ui/activity');
}

export function getRequestDetails(period: Period = 'all'): Promise<RequestDetailEntry[]> {
  return api.get<RequestDetailEntry[]>(`/ui/details?period=${period}`);
}

export function getRequestDetail(reqId: string): Promise<RequestDetailEntry | null> {
  return api.get<RequestDetailEntry | null>(`/ui/detail/${encodeURIComponent(reqId)}`);
}

export function getConversations(period: Period = 'all'): Promise<ConversationsResponse> {
  return api.get<ConversationsResponse>(`/ui/conversations?period=${period}`);
}

export function getSessions(params?: { status?: string; agent_type?: string; limit?: number; order?: 'newest' | 'oldest' }): Promise<SessionsResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.agent_type) qs.set('agent_type', params.agent_type);
  qs.set('limit', String(params?.limit ?? 50));
  qs.set('order', params?.order ?? 'newest');
  return api.get<SessionsResponse>(`/ui/sessions?${qs.toString()}`);
}

export function getAgents(): Promise<{ agents: AgentEntry[] }> {
  return api.get<{ agents: AgentEntry[] }>('/ui/agents');
}

export function getHostAgentStatus(): Promise<HostAgentStatus> {
  return api.get<HostAgentStatus>('/ui/host-agent/status');
}

/* ── Automations ── */
export function getAutomations(): Promise<AutomationListResponse> {
  return api.get<AutomationListResponse>('/ui/automations');
}

export function runAutomation(id: string, approved = false): Promise<unknown> {
  return api.post('/ui/automations/run', { id, approved });
}

export function deleteAutomation(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/ui/automations/${encodeURIComponent(id)}`);
}

/* ── Terminal ── */
export function getTerminalSessions(): Promise<TerminalSessionsResponse> {
  return api.get<TerminalSessionsResponse>('/ui/terminal/sessions');
}

export function submitTerminalCommand(sessionId: string, command: string): Promise<unknown> {
  return api.post('/ui/terminal/command', { sessionId, command });
}

export function approveTerminalRequest(requestId: string, approve = true): Promise<unknown> {
  return api.post('/ui/terminal/approve', { requestId, approve });
}

export function deleteTerminalSession(id: string): Promise<unknown> {
  return api.delete(`/ui/terminal/sessions/${encodeURIComponent(id)}`);
}

/* ── Models ── */
export function getModelCatalog(filter?: { provider?: string; capability?: string; q?: string }): Promise<{ models: CatalogModel[]; count: number }> {
  const qs = new URLSearchParams();
  if (filter?.provider) qs.set('provider', filter.provider);
  if (filter?.capability) qs.set('capability', filter.capability);
  if (filter?.q) qs.set('q', filter.q);
  const s = qs.toString();
  return api.get(`/ui/models/catalog${s ? `?${s}` : ''}`);
}

export function getModelCapabilities(): Promise<{ capabilities: string[] }> {
  return api.get<{ capabilities: string[] }>('/ui/models/capabilities');
}

export function getModelAliases(): Promise<{ aliases: ModelAlias[] }> {
  return api.get<{ aliases: ModelAlias[] }>('/ui/models/aliases');
}

export function estimateModelCost(modelId: string, inputTokens: number, outputTokens: number): Promise<ModelCostEstimate> {
  return api.post<ModelCostEstimate>('/ui/models/estimate-cost', { modelId, inputTokens, outputTokens });
}

/* ── Aggregated models (/api/models — all configured providers) ── */
/* Mirrors backend/providers/model-list.js getModelList() output. Free
 * models already sort first server-side, but we keep the flag so the UI
 * can badge them. */
export interface AggregatedModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
  isFree?: boolean;
}

export interface AggregatedModelsResponse {
  models: AggregatedModel[];
}

export function isFreeModelId(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  return lower.includes(':free') || lower.includes('-free') || lower.endsWith('free');
}

export function getAggregatedModels(): Promise<AggregatedModelsResponse> {
  return api.get<AggregatedModelsResponse>('/api/models');
}
