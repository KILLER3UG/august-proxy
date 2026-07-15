/* Request log, stats, activity, conversations, and non-chat session list APIs. */

import { api } from '../client';

export interface RequestEntry {
  /** Always present from requestLog. */
  reqId: string;
  clientType: string;
  endpoint: string;
  model: string;
  status: string;
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

export interface StoredSession {
  id: string;
  status?: string;
  agentType?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface SessionsResponse {
  sessions: StoredSession[];
  error?: string;
}

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

export interface HostAgentStatus {
  status: string;
}

export type Period = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'year';

export function getRequests(period: Period = 'all'): Promise<RequestsResponse> {
  return api.get<RequestsResponse>(`/api/requests?period=${period}`);
}

export function getStats(period: Period = 'all'): Promise<StatsResponse> {
  return api.get<StatsResponse>(`/api/stats?period=${period}`);
}

export function getActivity(): Promise<ActivityEntry[]> {
  return api.get<ActivityEntry[]>('/api/activity');
}

export function getRequestDetails(period: Period = 'all'): Promise<RequestDetailEntry[]> {
  return api.get<RequestDetailEntry[]>(`/api/details?period=${period}`);
}

export function getRequestDetail(reqId: string): Promise<RequestDetailEntry | null> {
  return api.get<RequestDetailEntry | null>(`/api/detail/${encodeURIComponent(reqId)}`);
}

export function getConversations(period: Period = 'all'): Promise<ConversationsResponse> {
  return api.get<ConversationsResponse>(`/api/conversations?period=${period}`);
}

export function getSessions(params?: {
  status?: string;
  agentType?: string;
  limit?: number;
  order?: 'newest' | 'oldest';
}): Promise<SessionsResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set('status', params.status);
  if (params?.agentType) qs.set('agentType', params.agentType);
  qs.set('limit', String(params?.limit ?? 50));
  qs.set('order', params?.order ?? 'newest');
  return api.get<SessionsResponse>(`/api/sessions?${qs.toString()}`);
}

export function getAgents(): Promise<{ agents: AgentEntry[] }> {
  return api.get<{ agents: AgentEntry[] }>('/api/agents');
}

export function getHostAgentStatus(): Promise<HostAgentStatus> {
  return api.get<HostAgentStatus>('/api/host-agent/health');
}

export function restartBackend(): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/system/restart');
}
