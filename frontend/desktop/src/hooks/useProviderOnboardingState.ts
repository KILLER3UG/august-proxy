/* ── Setup checklist / first-run onboarding state ───────────────────── */
/* Shows when the user has not completed or skipped the checklist.        */
/* Tracks provider, workspace, and optional Google connection.            */

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { providersApi, type Provider } from '@/api/providers';
import { useSessionsStore } from '@/store/sessions';

const SKIP_KEY = 'august-onboarding-skipped';
const DONE_KEY = 'august-setup-checklist-done';

export type SetupCheckItem = {
  id: 'provider' | 'workspace' | 'google';
  label: string;
  description: string;
  done: boolean;
  optional?: boolean;
  href?: string;
};

export function useProviderOnboardingState() {
  const qc = useQueryClient();

  const providersQ = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: () => providersApi.list(),
    staleTime: 30_000,
  });

  const googleQ = useQuery<{
    connections?: Record<string, { connected?: boolean; hasClientId?: boolean }>;
  }>({
    queryKey: ['integrations-connections'],
    queryFn: () =>
      fetch('/api/service-connections').then((r) => r.json()) as Promise<{
        connections?: Record<string, { connected?: boolean; hasClientId?: boolean }>;
      }>,
    staleTime: 30_000,
    retry: false,
  });

  const sessions = useSessionsStore((s) => s.sessions);
  const hasWorkspace = sessions.some((s) => Boolean(s.workspacePath));

  const providers = providersQ.data ?? [];
  const hasProvider = providers.length > 0;
  const googleConnected = Boolean(googleQ.data?.connections?.google?.connected);
  const googleReady = Boolean(
    googleQ.data?.connections?.google?.connected ||
      googleQ.data?.connections?.google?.hasClientId,
  );

  const dismissed =
    typeof localStorage !== 'undefined' &&
    (localStorage.getItem(SKIP_KEY) === 'true' || localStorage.getItem(DONE_KEY) === 'true');

  const checks: SetupCheckItem[] = useMemo(
    () => [
      {
        id: 'provider',
        label: 'Connect an AI provider',
        description: 'Anthropic, OpenAI, Gemini, or any OpenAI-compatible endpoint',
        done: hasProvider,
        href: '/settings/providers',
      },
      {
        id: 'workspace',
        label: 'Open a project folder',
        description: 'Pick a workspace so August can read and edit your files',
        done: hasWorkspace,
        href: '/',
      },
      {
        id: 'google',
        label: 'Sign in with Google (optional)',
        description: 'Gmail, Calendar, and Drive in one click when ready',
        done: googleConnected,
        optional: true,
        href: '/settings/integrations',
      },
    ],
    [hasProvider, hasWorkspace, googleConnected],
  );

  const requiredDone = hasProvider; // workspace is strongly recommended but provider is the hard gate
  const allCoreDone = hasProvider && hasWorkspace;

  // Show until user skips/completes, or while core setup is incomplete on first load
  const shouldShow =
    !dismissed && !providersQ.isLoading && (!hasProvider || !localStorage.getItem(DONE_KEY));

  // Prefer showing whenever provider list is empty OR checklist not marked done and incomplete
  const shouldShowChecklist =
    !dismissed &&
    !providersQ.isLoading &&
    (!allCoreDone || !hasProvider);

  const skip = () => {
    localStorage.setItem(SKIP_KEY, 'true');
    void qc.invalidateQueries({ queryKey: ['providers'] });
  };

  const markDone = () => {
    localStorage.setItem(DONE_KEY, 'true');
    localStorage.setItem(SKIP_KEY, 'true');
    void qc.invalidateQueries({ queryKey: ['providers'] });
  };

  const resetDismissed = () => {
    localStorage.removeItem(SKIP_KEY);
    localStorage.removeItem(DONE_KEY);
  };

  return {
    shouldShow: shouldShowChecklist || shouldShow,
    providers,
    checks,
    hasProvider,
    hasWorkspace,
    googleConnected,
    googleReady,
    allCoreDone,
    requiredDone,
    dismissed,
    isLoading: providersQ.isLoading,
    skip,
    markDone,
    resetDismissed,
  };
}
