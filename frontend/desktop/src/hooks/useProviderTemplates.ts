/* ── React Query hook for provider templates ──────────────────────────── */
/* Wraps GET /api/providers/templates with a 30-minute stale time so the
   static template data is not re-fetched on every mount. */

import { useQuery } from '@tanstack/react-query';
import { providersApi, type ProviderTemplate } from '@/api/providers';

export function useProviderTemplates() {
  const q = useQuery<ProviderTemplate[]>({
    queryKey: ['provider-templates'],
    queryFn: () => providersApi.templates(),
    staleTime: 30 * 60 * 1000, // 30 minutes — templates are static
  });

  return {
    templates: q.data ?? ([] as ProviderTemplate[]),
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}
