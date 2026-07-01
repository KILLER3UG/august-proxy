/* ── useModelProviders — shared data layer for the Model Providers
 *   section ─────────────────────────────────────────────────────────
 * The old Models.tsx and Providers.tsx components each fetched the
 * provider list (/api/config/activeProvider) independently. The new
 * Model Providers section uses this hook as the single fetcher and
 * passes the data down to whichever subtab needs it. */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  getAggregatedModels,
  isFreeModelId,
  type AggregatedModel,
} from '@/api/api-client';

export interface Provider {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
  redactedKey: string | null;
  authType?: string;
  signupUrl?: string;
}

export interface ActiveProviderData {
  activeProvider: string;
  providers: Provider[];
}

export function useModelProviders() {
  const providersQuery = useQuery({
    queryKey: ['mp-providers'],
    queryFn: () => api.get<ActiveProviderData>('/api/config/activeProvider'),
    refetchInterval: 30_000,
  });
  const modelsQuery = useQuery({
    queryKey: ['mp-aggregated-models'],
    queryFn: () => getAggregatedModels(),
    refetchInterval: 60_000,
  });

  const data = providersQuery.data;
  const providers = (data?.providers ?? []).slice().sort((a, b) => {
    if (a.id === data?.activeProvider) return -1;
    if (b.id === data?.activeProvider) return 1;
    if (a.isAvailable && !b.isAvailable) return -1;
    if (!a.isAvailable && b.isAvailable) return 1;
    return a.name.localeCompare(b.name);
  });

  const models: AggregatedModel[] = (modelsQuery.data?.models ?? []).map((m) => ({
    ...m,
    isFree: m.isFree ?? isFreeModelId(m.id),
  }));
  const freeCount = models.filter((m) => m.isFree).length;
  const reasoningCount = models.filter((m) => m.supportsReasoning || m.supportsThinking).length;
  const availableProviderCount = providers.filter((p) => p.isAvailable).length;

  return {
    providers,
    activeProvider: data?.activeProvider ?? null,
    models,
    freeCount,
    totalCount: models.length,
    reasoningCount,
    availableProviderCount,
    isLoading: providersQuery.isLoading && modelsQuery.isLoading,
  };
}
