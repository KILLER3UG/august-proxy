/* ── Computer use hooks (React Query) ────────────────────────────────── */
/* Health check and config for desktop automation */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details: Record<string, unknown>;
}

export interface HealthReport {
  platform: string;
  overall: 'ok' | 'warning' | 'error';
  checks: HealthCheck[];
  timestamp: string;
}

export interface ComputerUseConfig {
  enabled: boolean;
  backend: string;
  autoApprove: string[];
  blocklistKeys: string[];
  blocklistPatterns: string[];
}

export function useComputerUseHealth() {
  return useQuery<HealthReport>({
    queryKey: ['computer-use-health'],
    queryFn: async () => {
      return api.get<HealthReport>('/api/desktop-automation/health');
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useComputerUseConfig() {
  return useQuery<ComputerUseConfig>({
    queryKey: ['computer-use-config'],
    queryFn: async () => {
      return api.get<ComputerUseConfig>('/api/desktop-automation/config');
    },
    staleTime: 30_000,
  });
}
