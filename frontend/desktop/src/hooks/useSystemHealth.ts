/* ── System health (React Query) ──────────────────────────────────────── */
/* Fetches system health data from /api/brain/health */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface LayerInfo {
  layer: string;
  flag: string;
  flagValue: boolean;
  status: 'on & healthy' | 'on & failing' | 'off' | 'not shipped';
  detail: string;
  lastCheckAt: string;
}

export interface HealthData {
  phases: LayerInfo[];
}

export function useSystemHealth() {
  return useQuery<HealthData>({
    queryKey: ['brain-health'],
    queryFn: async () => {
      return api.get<HealthData>('/api/brain/health');
    },
    staleTime: 3_000,
    refetchInterval: 5_000,
  });
}
