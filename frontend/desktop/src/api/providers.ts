/* ── providers-api — typed client for /api/providers/* ───────────────── */

import { api } from './client';

/** Canonical wire formats for the backend provider store.
 * Legacy kebab-case aliases are still accepted/normalized server-side.
 */
export type ApiFormat =
  | 'openaiChat'
  | 'anthropicMessages'
  | 'openaiResponses'
  // Legacy UI values (normalized on save / resolve)
  | 'openai-chat'
  | 'anthropic'
  | 'openai-responses';

export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  free?: boolean;
  pinned?: boolean;
  source: 'manual' | 'fetched';
  /** Per-model wire-format override (e.g. a Claude model on OpenCode Zen that
   *  must use /v1/messages while the provider defaults to chat/completions).
   *  `null`/absent → provider apiFormat. */
  apiFormat?: ApiFormat | null;
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
  contextWindow?: number | null;
  reasoning?: boolean;
  free?: boolean;
  pinned?: boolean;
  /** Per-model wire-format override; null clears it back to provider format. */
  apiFormat?: ApiFormat | null;
}

export interface RefreshResult {
  added: string[];
  updated: string[];
  removed: string[];
}

export interface RefreshAllResult {
  refreshed: number;
  failed: number;
  added: number;
  removed: number;
}

export interface ConnectModelResult {
  success: boolean;
  content?: string;
  error?: string;
  latencyMs: number;
  httpStatus?: number;
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
  /** Apply (or overwrite) a provider's API key. Used by the model-driven
   *  setup flow: the model creates the provider via the setup_provider tool
   *  (no key), then the user pastes the key into the inline UI field, which
   *  calls this to PATCH /api/providers/{id} with just the key. */
  applyKey: (id: string, apiKey: string) =>
    api.patch<Provider>(p(`/${encodeURIComponent(id)}`), { apiKey }),
  addModel: (id: string, body: ModelCreate) =>
    api.post<Provider>(p(`/${encodeURIComponent(id)}/models`), body),
  updateModel: (id: string, modelId: string, body: Partial<ModelCreate>) =>
    api.patch<Provider>(p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`), body),
  removeModel: (id: string, modelId: string) =>
    api.delete<void>(p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}`)),
  refreshModels: (id: string) =>
    api.post<RefreshResult>(p(`/${encodeURIComponent(id)}/models/refresh`)),
  /** Bulk startup sync: refresh model lists for every enabled, keyed provider
   *  from its upstream /models endpoint (best-effort per provider). */
  refreshAllModels: () => api.post<RefreshAllResult>(p('/refresh-all')),
  /** Test whether a model is reachable + returns "WORKING" to a minimal prompt. */
  connectModel: (id: string, modelId: string) =>
    api.post<ConnectModelResult>(
      p(`/${encodeURIComponent(id)}/models/${encodeURIComponent(modelId)}/test`),
    ),
  /** Import a provider config from a JSON blob. */
  importConfig: (config: Record<string, unknown>) =>
    api.post<Provider>(`${p('')}/import-config`, config),
};
