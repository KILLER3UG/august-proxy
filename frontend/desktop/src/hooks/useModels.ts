/* ── Shared react-query hook for aggregated models ───────────────────── */
/* Used by ChatThread, WorkspaceModelsSection/AliasesTab, and Settings.    */
/* Invalidating the ['aggregated-models'] query key in any of those        */
/* locations triggers an automatic refetch everywhere.                     */

import { useQuery } from '@tanstack/react-query';
import { getAggregatedModels, type AggregatedModel } from '@/api/api-client';

export type { AggregatedModel };
export type ModelItem = AggregatedModel;

export function useModels() {
  const q = useQuery({
    queryKey: ['aggregated-models'],
    queryFn: () => getAggregatedModels(),
    refetchInterval: 60_000, // Poll every 60s so the dropdown stays up to date
    staleTime: 30_000,
  });

  return {
    models: q.data?.models ?? ([] as AggregatedModel[]),
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}
