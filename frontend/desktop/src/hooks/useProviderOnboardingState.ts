/* ── Provider Onboarding State ────────────────────────────────────────── */
/* Determines whether the first-launch onboarding modal should show.
   The modal is shown when the providers list is empty AND the user has not
   previously dismissed or skipped onboarding. */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providersApi, type Provider } from '@/api/providers';

const SKIP_KEY = 'august-onboarding-skipped';

export function useProviderOnboardingState() {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);

  const providersQ = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: () => providersApi.list(),
    staleTime: 30_000,
  });

  const providers = providersQ.data ?? [];
  const dismissed = localStorage.getItem(SKIP_KEY) === 'true';
  const shouldShow = !dismissed && providers.length === 0 && !providersQ.isLoading;

  const skip = () => {
    localStorage.setItem(SKIP_KEY, 'true');
    qc.invalidateQueries({ queryKey: ['providers'] });
    setTick((t) => t + 1);
  };

  const resetDismissed = () => {
    localStorage.removeItem(SKIP_KEY);
  };

  return {
    shouldShow,
    providers,
    dismissed,
    isLoading: providersQ.isLoading,
    skip,
    resetDismissed,
  };
}
