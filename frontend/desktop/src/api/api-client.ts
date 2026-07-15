/* ── Backend API helpers ───────────────────────────────────────────── */
/* Typed wrappers for Python FastAPI routes under /api/* (and /v1/* via
 * other modules). Secrets are redacted server-side; we never display raw keys.
 * Do not use legacy Node /ui/* paths — they are not served. */

import { api } from './client';

/* ── Shared shapes (from backend/lib/logger.js) ── */

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

/* ── Session store shapes (backend/services/storage/session-store.js) ── */
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

/* ── Preview (backend/services/workbench/preview-service.js) ── */
export interface PreviewSession {
  id: string;
  title?: string;
  cwd?: string;
  command?: string;
  status?: string;
  url?: string | null;
  createdAt?: string;
  updatedAt?: string;
  logLength?: number;
}

export interface PreviewApproval {
  requestId: string;
  id?: string;
  type?: string;
  command?: string;
  cwd?: string;
  title?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
}

export interface PreviewSessionsResponse {
  sessions: PreviewSession[];
  approvals: PreviewApproval[];
}

/* ── Terminal (backend/services/workbench/terminal-service.js) ── */
export interface TerminalSession {
  id: string;
  title?: string;
  cwd?: string;
  command?: string;
  status?: string;
  createdAt?: string;
  cols?: number;
  rows?: number;
  pty?: boolean;
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

export function getSessions(params?: { status?: string; agentType?: string; limit?: number; order?: 'newest' | 'oldest' }): Promise<SessionsResponse> {
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

/* ── Automations ── */
export function getAutomations(): Promise<AutomationListResponse> {
  return api.get<AutomationListResponse>('/api/automations');
}

export function runAutomation(id: string, approved = false): Promise<unknown> {
  return api.post('/api/automations/run', { id, approved });
}

export function deleteAutomation(id: string): Promise<{ deleted: boolean }> {
  return api.delete<{ deleted: boolean }>(`/api/automations/${encodeURIComponent(id)}`);
}

/* ── Preview ── */
export function getPreviewSessions(): Promise<PreviewSessionsResponse> {
  return api.get<PreviewSessionsResponse>('/api/preview/sessions');
}

export function startPreviewSession(params: { command: string; cwd?: string; title?: string; approved?: boolean }): Promise<PreviewSession | { status: 'approval_required'; requestId: string; reason: string }> {
  return api.post('/api/preview/sessions', params);
}

export function getPreviewSession(id: string): Promise<{ log: string } & PreviewSession> {
  return api.get<{ log: string } & PreviewSession>(`/api/preview/session/${encodeURIComponent(id)}`);
}

export function stopPreviewSession(id: string): Promise<{ deleted: boolean }> {
  return api.delete(`/api/preview/session/${encodeURIComponent(id)}`);
}

export function approvePreviewRequest(requestId: string, approve = true): Promise<unknown> {
  return api.post('/api/preview/approve', { requestId, approve });
}

/* ── Terminal ── */
export function getTerminalSessions(): Promise<TerminalSessionsResponse> {
  return api.get<TerminalSessionsResponse>('/api/terminal/sessions');
}

export function getTerminalBuffer(sessionId: string): Promise<{ buffer: string } & TerminalSession> {
  return api.get<{ buffer: string } & TerminalSession>(`/api/terminal/buffer?id=${encodeURIComponent(sessionId)}`);
}

export function createTerminalSession(params?: { cwd?: string; title?: string }): Promise<TerminalSession> {
  return api.post<TerminalSession>('/api/terminal/sessions', params || {});
}

export function submitTerminalCommand(sessionId: string, command: string): Promise<unknown> {
  return api.post('/api/terminal/command', { sessionId, command });
}

export function resizeTerminalSession(sessionId: string, cols: number, rows: number): Promise<unknown> {
  return api.post('/api/terminal/resize', { sessionId, cols, rows });
}

export function approveTerminalRequest(requestId: string, approve = true): Promise<unknown> {
  return api.post('/api/terminal/approve', { requestId, approve });
}

export function deleteTerminalSession(id: string): Promise<unknown> {
  return api.delete(`/api/terminal/sessions/${encodeURIComponent(id)}`);
}

/* ── Models ── */
export function getModelCatalog(filter?: { provider?: string; capability?: string; q?: string }): Promise<{ models: CatalogModel[]; count: number }> {
  const qs = new URLSearchParams();
  if (filter?.provider) qs.set('provider', filter.provider);
  if (filter?.capability) qs.set('capability', filter.capability);
  if (filter?.q) qs.set('q', filter.q);
  const s = qs.toString();
  return api.get(`/api/models/catalog${s ? `?${s}` : ''}`);
}

export function getModelCapabilities(): Promise<{ capabilities: string[] }> {
  return api.get<{ capabilities: string[] }>('/api/models/capabilities');
}

export function getModelAliases(): Promise<{ aliases: ModelAlias[] }> {
  return api.get<{ aliases: ModelAlias[] }>('/api/models/aliases');
}

export function estimateModelCost(modelId: string, inputTokens: number, outputTokens: number): Promise<ModelCostEstimate> {
  return api.post<ModelCostEstimate>('/api/models/estimate-cost', { modelId, inputTokens, outputTokens });
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
  hasMore?: boolean;
  total?: number;
  nextOffset?: number | null;
}

export function isFreeModelId(id: string): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  return lower.includes(':free') || lower.includes('-free') || lower.endsWith('free');
}

export interface AggregatedModelsOptions {
  skeleton?: boolean;
  refresh?: boolean;
  limit?: number;
  offset?: number;
}

export function getAggregatedModels(opts: AggregatedModelsOptions = {}): Promise<AggregatedModelsResponse> {
    const params = new URLSearchParams();
    if (opts.skeleton) params.set('skeleton', 'true');
    if (opts.refresh) params.set('refresh', 'true');
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return api.get<AggregatedModelsResponse>(`/api/models${qs ? `?${qs}` : ''}`);
}

/* ── User-defined model aliases (fake IDs that route to real models) ── */

export interface UserModelAlias {
  alias: string;
  targetModel: string;
  targetProvider: string;
  /** Prettified display name as shown in the chat dropdown
   *  (e.g. "Opus 4.7-Alias"). Matches the value usage events record,
   *  so the observability page can format "alias(backend)" correctly. */
  displayAlias?: string;
}

export interface UserModelAliasesResponse {
  aliases: UserModelAlias[];
}

export function getUserModelAliases(): Promise<UserModelAliasesResponse> {
  return api.get<UserModelAliasesResponse>('/api/config/model-aliases');
}

export function updateUserModelAliases(aliases: UserModelAlias[]): Promise<{ ok: boolean }> {
  return api.put<{ ok: boolean }>('/api/config/model-aliases', { aliases });
}

export interface SubAgentFallbackConfig {
  enabled: boolean;
  mode: 'off' | 'session_only' | 'marked_subagent_only' | 'always';
  provider: string;
  model: string;
}

// NOTE: the backend returns the fallback config object directly (not wrapped in
// { config: ... }), and the PUT endpoint accepts the config fields directly.
export function getSubAgentFallback(): Promise<SubAgentFallbackConfig> {
  return api.get<SubAgentFallbackConfig>('/api/config/subagent-fallback');
}

export function updateSubAgentFallback(config: SubAgentFallbackConfig): Promise<SubAgentFallbackConfig> {
  return api.put<SubAgentFallbackConfig>('/api/config/subagent-fallback', config);
}

/* ── Background Review / Reflection model config ───────────────────── */
// Three independent model selectors (review, reflection, auto-memory).
// Each model field is an alias/model id that resolves to a real provider+model.
// When a field is empty, the chat session's model is used for that task.
export interface ReviewBackgroundConfig {
  enabled: boolean;
  reviewModel: string;
  reflectionModel: string;
  autoMemoryModel: string;
}

export function getReviewBackgroundConfig(): Promise<ReviewBackgroundConfig> {
  return api.get<ReviewBackgroundConfig>('/api/config/background-review');
}

export function updateReviewBackgroundConfig(config: ReviewBackgroundConfig): Promise<ReviewBackgroundConfig> {
  return api.put<ReviewBackgroundConfig>('/api/config/background-review', config);
}

/* ── Model Fleet (v4.1) — four cognitive roles → models (spec §10) ────── */
export interface ModelFleetConfig {
  cortex: string;
  cerebellum: string;
  hippocampus: string;
  prefrontal: string;
}

export function getModelFleet(): Promise<ModelFleetConfig> {
  return api.get<ModelFleetConfig>('/api/config/model-fleet');
}

export function updateModelFleet(
  patch: Partial<ModelFleetConfig>,
): Promise<ModelFleetConfig> {
  return api.put<ModelFleetConfig>('/api/config/model-fleet', patch);
}

/* ── Live (STT/TTS) config (v4.2) — provider/model/voice selection ─────── */
// Empty provider = "use browser default" (Web Speech API). Setting a
// provider upgrades the speech path to a paid service. Mirrors model_fleet.
export interface LiveConfig {
  sttProvider: string;
  sttModel: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
}

export function getLiveConfig(): Promise<LiveConfig> {
  return api.get<LiveConfig>('/api/config/live');
}

export function updateLiveConfig(
  patch: Partial<LiveConfig>,
): Promise<LiveConfig> {
  return api.put<LiveConfig>('/api/config/live', patch);
}

/* ── Brain Activity (v4.3) — realtime feed of brain-internal events ─── */
export interface BrainEvent {
  id: string;
  category:
    | 'consolidation'
    | 'delta_engine'
    | 'heuristic'
    | 'review'
    | 'skill_genesis'
    | 'session';
  layer: string;
  summary: string;
  meta: Record<string, unknown>;
  at: string; // ISO8601 UTC, ends with Z
}

export function getBrainEvents(
  limit = 200,
  category?: BrainEvent['category'],
): Promise<BrainEvent[]> {
  const q = category ? `?limit=${limit}&category=${category}` : `?limit=${limit}`;
  return api.get<BrainEvent[]>(`/api/brain/events${q}`);
}

// SSE client returns an EventSource-like object that the caller closes.
// Kept here (not in a hook) so it can be tested in isolation.
export function openBrainEventStream(): EventSource {
  return new EventSource('/api/brain/events/stream');
}

export function restartBackend(): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/api/system/restart');
}

/* ── August self-management API (Task 4 + 6) ──────────────────────────── */

export interface AugustSnapshot {
  sessions?: unknown[];
  config?: { security?: { allowedRoots: string[]; filesystemScope: 'allowlist' | 'root'; postObservationScreenshot?: boolean } };
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

/* ── Settings/management API ──────────────────────────────────────────── */
// Uses existing RESTful endpoints. Aliases, settings, and snapshot live
// under /api/manage/; other resources use their dedicated routers.

// Sessions (uses /api/sessions router)
export function listManageSessions(): Promise<StoredSession[]> {
  return api.get<{ sessions: StoredSession[] }>('/api/sessions').then(r => r.sessions ?? []);
}
export function createManageSession(params?: { provider?: string; agentId?: string; guardMode?: string }): Promise<unknown> {
  return api.post('/api/sessions', params || {});
}
export function deleteManageSession(id: string): Promise<unknown> {
  return api.delete(`/api/sessions/${encodeURIComponent(id)}`);
}

// Providers (uses /api/providers router)
export function listManageProviders(): Promise<unknown[]> {
  return api.get('/api/providers');
}
export function createManageProvider(body: { name: string; baseUrl: string; apiFormat?: string; apiKey?: string; enabled?: boolean }): Promise<unknown> {
  return api.post('/api/providers', body);
}

// Agents (uses /api/agents router)
export function listManageAgents(): Promise<AgentEntry[]> {
  return api.get<{ agents: AgentEntry[] }>('/api/agents').then(r => r.agents ?? []);
}
export function createManageAgent(body: { name: string; parentId?: string; permissions?: string[]; toolsets?: string[]; model?: string; provider?: string }): Promise<unknown> {
  return api.post('/api/agents', body);
}
export function deleteManageAgent(id: string): Promise<unknown> {
  return api.delete(`/api/agents/${encodeURIComponent(id)}`);
}

// Aliases (uses /api/manage/aliases router)
export function listManageAliases(): Promise<Array<{ alias: string; targetModel: string }>> {
  return api.get('/api/manage/aliases');
}
export function createManageAlias(body: { alias: string; targetModel: string; targetProvider?: string }): Promise<unknown> {
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
  return api.get<{ facts: MemoryFact[] }>(`/api/memory/facts${category ? `?category=${encodeURIComponent(category)}` : ''}`).then(r => r.facts ?? []);
}
export function createManageMemoryFact(body: { key: string; value: unknown; category?: string }): Promise<unknown> {
  return api.post('/api/memory/facts', body);
}
export function deleteManageMemoryFact(key: string): Promise<unknown> {
  return api.delete(`/api/memory/facts/${encodeURIComponent(key)}`);
}

// Settings (uses /api/manage/settings router)
export function updateManageSettings(updates: Record<string, unknown>): Promise<{ updated: string[] }> {
  return api.put('/api/manage/settings', { updates });
}

// Snapshot (uses /api/manage/snapshot router)
export function getManageSnapshot(): Promise<unknown> {
  return api.get('/api/manage/snapshot');
}

/* ── Legacy /api/august/* wrappers (deprecated, kept for backward compat) ── */

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

/* ── Model aliases management ──────────────────────────────────────────── */

export function manageAugustAliases(payload: {
  action: 'list' | 'upsert' | 'delete';
  alias?: string;
  targetModel?: string;
  targetProvider?: string;
}): Promise<{ ok: boolean; aliases?: Array<{ alias: string; targetModel: string }>; alias?: string; deleted?: boolean }> {
  return api.post('/api/august/aliases/manage', payload);
}

/* ── Tool management (MCP + plugins) ──────────────────────────────────── */

export function manageAugustTools(payload: {
  action: 'list' | 'upsert' | 'delete';
  kind?: 'mcp' | 'plugin';
  name?: string;
  config?: Record<string, unknown>;
}): Promise<{ ok: boolean; tools?: unknown; tool?: unknown; name?: string; deleted?: boolean }> {
  return api.post('/api/august/tools/manage', payload);
}

/* ── Computer-use app policy (Task 6) ─────────────────────────────────── */

export interface AppPolicy {
  app: string;
  policy: 'allow' | 'ask' | 'deny';
}

export function setAugustAppPolicy(policy: AppPolicy): Promise<{ ok: boolean; app: string; policy: string }> {
  return api.post('/api/august/computer/app-policy', { action: 'set', ...policy });
}

export function deleteAugustAppPolicy(app: string): Promise<{ ok: boolean; app: string }> {
  return api.post('/api/august/computer/app-policy', { action: 'delete', app });
}

export function listAugustAppPolicies(): Promise<{ ok: boolean; policies: Record<string, 'allow' | 'ask' | 'deny'> }> {
  return api.post('/api/august/computer/app-policy', { action: 'list' });
}

/* ── UI events (Task 5) ──────────────────────────────────────────────── */

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

/* ── Audit log (Task 2) ───────────────────────────────────────────────── */

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  agentId?: string | null;
  sessionId?: string | null;
  action: string;
  target?: string | null;
  category?: string | null;
  mode?: string | null;
  critical?: boolean | null;
  approved?: boolean | null;
  approvalToken?: string | null;
  inputSummary?: unknown;
  beforeSummary?: unknown;
  afterSummary?: unknown;
  rollbackId?: string | null;
  postObservation?: { screenshotPath?: string | null; capturedAt?: string; focusedApp?: string | null } | null;
  result: string;
  error?: string | null;
}

export function getAuditLog(opts: number | { limit?: number; category?: string; actor?: string; action?: string; since?: string; until?: string; summary?: boolean } = 200): Promise<{ entries: AuditEntry[]; total?: number; at?: string }> {
    if (typeof opts === 'number') {
        return api.get<{ entries: AuditEntry[]; total?: number; at?: string }>(`/api/audit?limit=${opts}`);
    }
    const p = new URLSearchParams();
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.category) p.set('category', opts.category);
    if (opts.actor) p.set('actor', opts.actor);
    if (opts.action) p.set('action', opts.action);
    if (opts.since) p.set('since', opts.since);
    if (opts.until) p.set('until', opts.until);
    if (opts.summary) p.set('summary', '1');
    const qs = p.toString();
    return api.get<{ entries: AuditEntry[]; total?: number; at?: string }>(`/api/audit${qs ? `?${qs}` : ''}`);
}

export interface AuditSummary {
    count: number;
    byCategory: Record<string, number>;
    byResult: Record<string, number>;
    byActor: Record<string, number>;
    byCritical: { true: number; false: number; null: number };
    at: string;
}

export function getAuditSummary(): Promise<AuditSummary> {
    return api.get<AuditSummary>('/api/audit?summary=1');
}

export interface RollbackEntry {
  id: string;
  at: string;
  type: string;
  target: string;
  before: unknown;
  after: unknown;
  status: string;
}

export function getRollbackList(opts: number | { limit?: number; status?: 'available' | 'undone' | 'failed'; type?: string; summary?: boolean } = 100): Promise<{ items: RollbackEntry[]; total?: number; at?: string }> {
    if (typeof opts === 'number') {
        return api.get<{ items: RollbackEntry[]; total?: number; at?: string }>(`/api/rollback?limit=${opts}`);
    }
    const p = new URLSearchParams();
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.status) p.set('status', opts.status);
    if (opts.type) p.set('type', opts.type);
    if (opts.summary) p.set('summary', '1');
    const qs = p.toString();
    return api.get<{ items: RollbackEntry[]; total?: number; at?: string }>(`/api/rollback${qs ? `?${qs}` : ''}`);
}

export interface RollbackSummary {
    available: number;
    undone: number;
    failed: number;
    total: number;
    byType: Record<string, number>;
    at: string;
}

export function getRollbackSummary(): Promise<RollbackSummary> {
    return api.get<RollbackSummary>('/api/rollback?summary=1');
}

/* ── Post-observation screenshot gallery (Task 2) ──────────────────────── */

export interface PostObservation {
    id: string;
    screenshotPath: string;
    capturedAt: string;
    focusedApp: string | null;
    audit?: {
        id: string;
        at: string;
        action: string;
        target: string | null;
        result: string;
    };
}

export function getObservations(opts: { limit?: number; since?: string } = {}): Promise<{ items: PostObservation[]; total: number; at: string }> {
    const p = new URLSearchParams();
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.since) p.set('since', opts.since);
    const qs = p.toString();
    return api.get<{ items: PostObservation[]; total: number; at: string }>(`/api/observations${qs ? `?${qs}` : ''}`);
}

export function getObservationUrl(id: string): string {
    return `/api/observations/${encodeURIComponent(id)}.png`;
}

/* ── Host-agent health (Task 3) ───────────────────────────────────────── */

export interface HostAgentHealth {
    status: 'connected' | 'disconnected' | 'error';
    lastComputerActionAt: string | null;
    lastComputerAction: string | null;
    lastComputerTarget: string | null;
    lastObservationAt: string | null;
    lastObservedApp: string | null;
    postObservationCount: number;
    at: string;
}

export function getHostAgentHealth(): Promise<HostAgentHealth> {
    return api.get<HostAgentHealth>('/api/host-agent/health');
}

/* ── Security write-back (Task 3) ─────────────────────────────────────── */

export interface SecurityConfig {
    allowedRoots: string[];
    filesystemScope: 'allowlist' | 'root';
    postObservationScreenshot: boolean;
}

export function putSecurity(body: Partial<SecurityConfig>): Promise<{ ok: boolean; security: SecurityConfig }> {
    return api.put<{ ok: boolean; security: SecurityConfig }>('/api/security', body);
}

/* ── Observability overview (Task 3) ───────────────────────────────────── */

export interface ObservabilityOverview {
    range: '7d' | '30d';
    audit: AuditSummary;
    rollback: RollbackSummary;
    appPolicy: { policies: Record<string, 'allow' | 'ask' | 'deny'>; counts: Record<'allow' | 'ask' | 'deny', number>; defaultPolicy: 'ask' };
    hostAgent: HostAgentHealth;
    at: string;
}

export function getObservabilityOverview(range: '7d' | '30d' = '30d'): Promise<ObservabilityOverview> {
    return api.get<ObservabilityOverview>(`/api/observability/overview?range=${range}`);
}

/* ── Live log event stream (Settings → Backend Monitor) ─────────────── */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory =
    | 'proxy_incoming'
    | 'proxy_upstream'
    | 'proxy_debug'
    | 'proxy_model_route'
    | 'proxy_context'
    | 'proxy_tools'
    | 'proxy_system_prompt'
    | 'auto_memory'
    | 'scheduler'
    | 'security'
    | 'error'
    | 'info';

export interface LogEvent {
    id: string;
    timestamp: number;
    category: string;
    level: LogLevel;
    message: string;
    metadata: Record<string, unknown> | null;
    raw: string | null;
}

export function getRecentLogs(limit = 200): Promise<{ events: LogEvent[]; count: number }> {
    const n = Math.max(1, Math.min(2000, Number(limit) || 200));
    return api.get<{ events: LogEvent[]; count: number }>(`/api/logs/recent?limit=${n}`);
}

/* ── External API gateway access ───────────────────────────────────── */
/* Config endpoints that gate the /v1/* proxy surface behind a Bearer
 * key. Used by the API Access settings section and the System Health
 * panel's "Connect an app" block. */

export interface ExternalAccessConfig {
  enabled: boolean;
  hasKey: boolean;
  /** Masked preview of GATEWAY_API_KEY, or null when not configured. */
  keyPreview: string | null;
  /** Where the key is loaded from (env or generated config). */
  source: 'env' | 'config' | null;
  endpoints: {
    anthropic: string;
    openai: string;
    models: string;
  };
}

export function getExternalAccessConfig(): Promise<ExternalAccessConfig> {
  return api.get<ExternalAccessConfig>('/api/config/external-access');
}

export function updateExternalAccessConfig(body: {
  enabled: boolean;
}): Promise<{ enabled: boolean; hasKey: boolean; keyPreview: string | null; source: string | null }> {
  return api.put('/api/config/external-access', body);
}

export function generateGatewayApiKey(): Promise<{
  apiKey: string;
  hasKey: boolean;
  keyPreview: string | null;
  source: string | null;
  message?: string;
}> {
  return api.post('/api/config/external-access/generate-key', {});
}

/* ── Feature Flow (live backend pipeline visualization) ─────────────── */

export interface FeatureFlowEvent {
  id: string;
  traceId: string;
  feature: string;
  stage: string;
  status: 'running' | 'ok' | 'error' | string;
  summary: string;
  error: string | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
  at: string;
}

export interface FeatureInventoryItem {
  id: string;
  name: string;
  description: string;
  stages: string[];
}

export function getFeatureInventory(): Promise<{ features: FeatureInventoryItem[]; count: number }> {
  return api.get('/api/monitor/features');
}

export function getFeatureFlowEvents(
  limit = 200,
  feature?: string,
  status?: string,
): Promise<FeatureFlowEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (feature) params.set('feature', feature);
  if (status) params.set('status', status);
  return api.get(`/api/monitor/events?${params.toString()}`);
}

export function openFeatureFlowEventStream(): EventSource {
  return new EventSource('/api/monitor/events/stream');
}

export function getInjectAugOnProxy(): Promise<{ enabled: boolean }> {
  return api.get('/api/config/inject-aug-on-proxy');
}

export function updateInjectAugOnProxy(body: { enabled: boolean }): Promise<{ enabled: boolean }> {
  return api.put('/api/config/inject-aug-on-proxy', body);
}
