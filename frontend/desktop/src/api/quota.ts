/* ── quota-api ─ typed client for /api/providers/quota ──────────────── */

import { api } from './client';

export interface ModelQuota {
  provider: string;
  model: string;
  used: number;
  prompt: number;
  completion: number;
  limit: number | null;
  percent: number;
  resetsAt: string;
  source: 'native' | 'local' | 'none';
}

export const quotaApi = {
  forProvider:  (provider: string) =>
    api.get<{ results: ModelQuota[] }>(`/api/providers/quota?provider=${encodeURIComponent(provider)}`),
  forModel:      (provider: string, model: string) =>
    api.get<ModelQuota>(`/api/providers/quota?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`),
  all:           () => api.get<{ results: Array<{ provider: string; quotas: ModelQuota[] }> }>('/api/providers/quota'),
};
