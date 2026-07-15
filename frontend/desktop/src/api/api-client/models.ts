/* Model catalog, aggregated provider lists, aliases, fallback, and fleet config. */

import { api } from '../client';

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

export function getModelCatalog(filter?: {
  provider?: string;
  capability?: string;
  q?: string;
}): Promise<{ models: CatalogModel[]; count: number }> {
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

export function estimateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<ModelCostEstimate> {
  return api.post<ModelCostEstimate>('/api/models/estimate-cost', {
    modelId,
    inputTokens,
    outputTokens,
  });
}

/* Aggregated models (/api/models — all configured providers). Free models
 * already sort first server-side; isFree badges them in the UI. */
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

export function getAggregatedModels(
  opts: AggregatedModelsOptions = {},
): Promise<AggregatedModelsResponse> {
  const params = new URLSearchParams();
  if (opts.skeleton) params.set('skeleton', 'true');
  if (opts.refresh) params.set('refresh', 'true');
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return api.get<AggregatedModelsResponse>(`/api/models${qs ? `?${qs}` : ''}`);
}

/* User-defined model aliases (fake IDs that route to real models). */

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

// Backend returns the fallback config object directly (not wrapped in
// { config: ... }), and the PUT endpoint accepts the config fields directly.
export function getSubAgentFallback(): Promise<SubAgentFallbackConfig> {
  return api.get<SubAgentFallbackConfig>('/api/config/subagent-fallback');
}

export function updateSubAgentFallback(
  config: SubAgentFallbackConfig,
): Promise<SubAgentFallbackConfig> {
  return api.put<SubAgentFallbackConfig>('/api/config/subagent-fallback', config);
}

/* Background Review / Reflection model config. Three independent model
 * selectors (review, reflection, auto-memory). Empty field → chat session model. */
export interface ReviewBackgroundConfig {
  enabled: boolean;
  reviewModel: string;
  reflectionModel: string;
  autoMemoryModel: string;
}

export function getReviewBackgroundConfig(): Promise<ReviewBackgroundConfig> {
  return api.get<ReviewBackgroundConfig>('/api/config/background-review');
}

export function updateReviewBackgroundConfig(
  config: ReviewBackgroundConfig,
): Promise<ReviewBackgroundConfig> {
  return api.put<ReviewBackgroundConfig>('/api/config/background-review', config);
}

/* Model Fleet — four cognitive roles → models. */
export interface ModelFleetConfig {
  cortex: string;
  cerebellum: string;
  hippocampus: string;
  prefrontal: string;
}

export function getModelFleet(): Promise<ModelFleetConfig> {
  return api.get<ModelFleetConfig>('/api/config/model-fleet');
}

export function updateModelFleet(patch: Partial<ModelFleetConfig>): Promise<ModelFleetConfig> {
  return api.put<ModelFleetConfig>('/api/config/model-fleet', patch);
}
