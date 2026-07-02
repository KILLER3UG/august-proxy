/* ── providers-api — typed client for /api/providers/* ───────────────── */

import { api } from './client';

export type ApiFormat = 'openai-chat' | 'anthropic' | 'openai-responses';

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  free?: boolean;
  source: 'manual' | 'fetched';
  createdAt?: string;
  updatedAt?: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  enabled: boolean;
  apiKeySet: boolean;
  apiKey?: string;
  autoFetch?: boolean;
  models: ProviderModel[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderCreate {
  id?: string;
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  apiKey?: string;
  enabled?: boolean;
  autoFetch?: boolean;
}

export type ProviderUpdate = Partial<Omit<ProviderCreate, 'id'>>;

export interface ModelCreate {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  free?: boolean;
}

export interface RefreshResult {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface ConnectModelResult {
  success: boolean;
  content?: string;
  error?: string;
  latencyMs: number;
  httpStatus?: number;
}

/** Model profile from a provider template. */
export interface ModelProfile {
  supportsReasoning?: boolean;
  supportsThinking?: boolean;
  combinedBudget?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingReserve?: number;
  safetyBuffer?: number;
}

/** A provider template definition (from provider_templates.json). */
export interface ProviderTemplate {
  id: string;
  name: string;
  displayName: string;
  description: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  authType: string;
  envVars: string[];
  defaultModel: string;
  defaultMaxTokens: number;
  signupUrl: string;
  supportsHealthCheck: boolean;
  aliases: string[];
  fallbackModels: string[];
  defaultHeaders: Record<string, string>;
  modelProfiles: Record<string, ModelProfile>;
}

function p(path: string) {
  return `/api/providers${path}`;
}

export const providersApi = {
  list: () => api.get<Provider[]>(p('')),
  get: (id: string) => api.get<Provider>(p(`/${encodeURIComponent(id)}`)),
  create: (body: ProviderCreate) => api.post<Provider>(p(''), body),
  update: (id: string, body: ProviderUpdate) => api.patch<Provider>(p(`/${encodeURIComponent(id)}`), body),
  remove: (id: string) => api.delete<void>(p(`/${encodeURIComponent(id)}`)),
  addModel: (id: string, body: ModelCreate) =>
    api.post<Provider>(p(`/${encodeURIComponent(id)}/models`), body),
  updateModel: (id: string, modelId: string, body: Partial<ModelCreate>) =>
    api.patch<Provider>(p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`), body),
  removeModel: (id: string, modelId: string) =>
    api.delete<void>(p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`)),
  refreshModels: (id: string) =>
    api.post<RefreshResult>(p(`/${encodeURIComponent(id)}/models/refresh`)),
  /** Test whether a model is reachable + returns "WORKING" to a minimal prompt. */
  connectModel: (id: string, modelId: string) =>
    api.post<ConnectModelResult>(
      p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/test`),
    ),
  /** Get all provider templates (static definitions from provider_templates.json). */
  templates: () => api.get<ProviderTemplate[]>(`${p('')}/templates`),
  /** Import a provider config from a JSON blob. */
  importConfig: (config: Record<string, unknown>) =>
    api.post<Provider>(`${p('')}/import-config`, config),
};
