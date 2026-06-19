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

function p(path: string) {
  return `/api/providers${path}`;
}

export const providersApi = {
  list: () => api.get<Provider[]>(p('')),
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
};
