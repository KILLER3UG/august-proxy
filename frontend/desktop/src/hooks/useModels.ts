/* ── Shared react-query hook for aggregated models ───────────────────── */
/* Source of truth: Model settings / providers catalog (backend aggregate).
 * After provider CRUD, call refreshProviderCatalog() so this hook updates
 * chat model dropdowns without a backend restart. */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAggregatedModels, type AggregatedModel } from '@/api/api-client';
import { refreshProviderCatalog } from '@/lib/provider-catalog';

export type { AggregatedModel };
export type ModelItem = AggregatedModel;

export function useModels() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
    // Keep chat picker fresh; provider mutations still force refresh via
    // refreshProviderCatalog (refresh=true on the server).
    // Realtime `invalidate` on provider/catalog changes; poll is a slow safety net.
    refetchInterval: 120_000,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  return {
    models: q.data?.models ?? ([] as AggregatedModel[]),
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
    /** Hard refresh: bust backend cache + all catalog consumers. */
    refreshCatalog: () => refreshProviderCatalog(qc),
  };
}
