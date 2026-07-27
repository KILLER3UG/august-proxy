/* One-shot provider model sync when the backend comes up.
 *
 * The desktop app calls POST /api/providers/refresh-all once per launch so
 * models added or removed upstream since the last run appear in the chat
 * model dropdown without a manual "Discover all". Best-effort: failures
 * leave the stored model list (and the dropdown) untouched.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { providersApi } from '@/api/providers';
import { refreshProviderCatalog } from '@/lib/provider-catalog';
import { $gateway } from '@/store/gateway';

// Once per app launch — module scope survives route changes, resets on reload.
let startupRefreshDone = false;

/** Test-only: allow the one-shot guard to be re-armed between cases. */
export function resetStartupRefresh(): void {
  startupRefreshDone = false;
}

export function useStartupProviderRefresh(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    const runOnce = () => {
      if (startupRefreshDone || cancelled) return;
      startupRefreshDone = true;
      providersApi
        .refreshAllModels()
        .then(() => refreshProviderCatalog(queryClient))
        .catch(() => {
          /* best-effort: the dropdown falls back to stored models */
        });
    };
    // $gateway.subscribe fires immediately with the current state, then on
    // every change — covers both "backend already up" and "comes up later".
    const unsubscribe = $gateway.subscribe((gateway) => {
      if (gateway.status === 'open') runOnce();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [queryClient]);
}
