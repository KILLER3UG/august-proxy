/* ── Provider availability (React Query) ──────────────────────────── */
/* Replaces the one-shot useEffect in ChatThread so newly-added providers */
/* appear in the model dropdown without remounting the chat. */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface ProviderAvailability {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
}

export interface ProviderAvailabilityResponse {
  activeProvider: string | null;
  providers: ProviderAvailability[];
}

export function useProviderAvailability() {
  const q = useQuery<ProviderAvailabilityResponse>({
    queryKey: ['provider-availability'],
    queryFn: async () => {
      return api.get<ProviderAvailabilityResponse>('/api/config/activeProvider');
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  return {
    providers: q.data?.providers ?? ([] as ProviderAvailability[]),
    activeProvider: q.data?.activeProvider ?? null,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}
