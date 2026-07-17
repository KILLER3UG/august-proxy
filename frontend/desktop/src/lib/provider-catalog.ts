/* ── Provider catalog — single source of truth for model lists ───────── */
/* When providers change (create/update/delete/key/models), call
 * refreshProviderCatalog so chat dropdowns, aliases, fleet, and settings
 * all see the new models without a backend restart. */

import type { QueryClient } from '@tanstack/react-query';
import { getAggregatedModels } from '@/api/api-client';

/** Every react-query key that derives models or providers from the catalog. */
export const PROVIDER_CATALOG_QUERY_KEYS = [
  ['aggregated-models'],
  ['mp-aggregated-models'],
  ['ws-providers'],
  ['providers'],
  ['mp-providers'],
  ['provider-availability'],
  ['model-options'],
  ['user-model-aliases'],
  ['provider-health'],
  ['subagent-fallback-config'],
  ['review-background-config'],
] as const;

/**
 * Bust backend model-list cache and invalidate all client catalog queries.
 * Prefer this over ad-hoc invalidateQueries after any provider mutation.
 */
export async function refreshProviderCatalog(qc: QueryClient): Promise<void> {
  // Force server-side aggregate() to re-read providers + re-fetch /models.
  try {
    await getAggregatedModels({ refresh: true });
  } catch {
    /* network errors still fall through to invalidate so UI retries */
  }
  await Promise.all(
    PROVIDER_CATALOG_QUERY_KEYS.map((queryKey) =>
      qc.invalidateQueries({ queryKey: [...queryKey] }),
    ),
  );
  // Ensure open chat dropdowns refetch immediately, not only on remount.
  await Promise.all([
    qc.refetchQueries({ queryKey: ['aggregated-models'] }),
    qc.refetchQueries({ queryKey: ['ws-providers'] }),
    qc.refetchQueries({ queryKey: ['provider-availability'] }),
  ]);
}
