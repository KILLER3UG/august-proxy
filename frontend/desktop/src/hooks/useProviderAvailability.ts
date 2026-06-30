/* ── Provider availability (React Query) ──────────────────────────── */
/* Replaces the one-shot useEffect in ChatThread so newly-added providers */
/* appear in the model dropdown without remounting the chat. */

import { useQuery } from '@tanstack/react-query';

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
      const res = await fetch('/api/config/activeProvider');
      if (!res.ok) throw new Error('Failed to fetch provider availability');
      return res.json();
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
