/* ── quota-api ─ typed client for /api/providers/quota ──────────────── */

import { api } from './client';

export interface ModelQuota {
  provider: string;
  model: string;
  /** Tokens August itself spent on this model in the usage window. */
  used: number;
  prompt: number;
  completion: number;
  /** Provider-stated cap. null unless the provider actually published one —
   *  a local row never invents a ceiling. */
  limit: number | null;
  /** Provider-stated remaining budget (native rows only). */
  remaining: number | null;
  /** Provider-side consumption = limit − remaining. Native rows only; it
   *  counts the provider's own window, not August's spend. */
  nativeUsed: number | null;
  percent: number;
  /** ISO-8601 when the provider's budget resets. */
  resetsAt: string | null;
  /** When the native reading was taken (ISO-8601, native rows only). */
  observedAt: string | null;
  /** 'native' = the provider stated this budget; 'local' = August's own
   *  token estimate over the usage window; 'none' = nothing known. */
  source: 'native' | 'local' | 'none';
}

export interface ProviderQuotaGroup {
  provider: string;
  quotas: ModelQuota[];
}

export const quotaApi = {
  forProvider:  (provider: string) =>
    api.get<{ results: ModelQuota[] }>(`/api/providers/quota?provider=${encodeURIComponent(provider)}`),
  forModel:      (provider: string, model: string) =>
    api.get<ModelQuota>(`/api/providers/quota?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`),
  all:           () => api.get<{ results: ProviderQuotaGroup[] }>('/api/providers/quota'),
};
