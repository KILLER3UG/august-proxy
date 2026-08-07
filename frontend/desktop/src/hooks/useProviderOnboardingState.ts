/* ── Setup checklist / first-run onboarding state ───────────────────── */
/* Shows when the user has not completed or skipped the checklist.        */
/* Tracks provider, workspace, Google, plus doctor (backend/MCP/disk).    */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { providersApi, type Provider } from '@/api/providers';
import { getWorkbenchDoctor, type DoctorReport } from '@/api/workbench';
import { useSessionsStore } from '@/store/sessions';

const SKIP_KEY = 'august-onboarding-skipped';
const DONE_KEY = 'august-setup-checklist-done';

export type SetupCheckItem = {
  id: 'provider' | 'workspace' | 'google' | 'doctor';
  label: string;
  description: string;
  done: boolean;
  optional?: boolean;
  href?: string;
};

export function useProviderOnboardingState() {
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

  const doctorQ = useQuery<DoctorReport>({
    queryKey: ['workbench-doctor'],
    queryFn: () => getWorkbenchDoctor(),
    staleTime: 15_000,
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

  const doctor = doctorQ.data;
  const doctorOk = Boolean(doctor?.ok);
  const doctorDetail =
    doctor?.summary ||
    (doctorQ.isError ? 'Could not reach doctor endpoint' : 'Checking health…');

  // Reactive dismissal flag — localStorage alone does not trigger a
  // re-render, so skip()/markDone() must flip this state to close the
  // modal immediately (seeded from storage on first mount).
  const [dismissed, setDismissed] = useState(
    () =>
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem(SKIP_KEY) === 'true' || localStorage.getItem(DONE_KEY) === 'true'),
  );

  const checks: SetupCheckItem[] = useMemo(
    () => [
      {
        id: 'provider',
        label: 'Connect an AI provider',
        description: 'Anthropic, OpenAI, or any OpenAI-compatible endpoint',
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
        id: 'doctor',
        label: 'System health',
        description: doctorDetail,
        done: doctorOk,
        optional: true,
        href: '/settings/system-health',
      },
      {
        id: 'google',
        label: 'Sign in with Google (optional)',
        description: 'Gmail, Calendar, and Drive in one click when ready',
        done: googleConnected,
        optional: true,
        href: '/settings/tools-connections',
      },
    ],
    [hasProvider, hasWorkspace, googleConnected, doctorOk, doctorDetail],
  );

  const requiredDone = hasProvider; // workspace is strongly recommended but provider is the hard gate
  const allCoreDone = hasProvider && hasWorkspace;

  // Show the setup checklist while core setup is incomplete AND the user has
  // not skipped/marked it done. Fully-configured users never see it again —
  // previously the tautology `shouldShowChecklist || shouldShow` re-showed
  // the modal on every launch until an explicit Done/Skip.
  const shouldShow = !dismissed && !providersQ.isLoading && !allCoreDone;

  const skip = () => {
    localStorage.setItem(SKIP_KEY, 'true');
    setDismissed(true);
  };

  const markDone = () => {
    localStorage.setItem(DONE_KEY, 'true');
    localStorage.setItem(SKIP_KEY, 'true');
    setDismissed(true);
  };

  const resetDismissed = () => {
    localStorage.removeItem(SKIP_KEY);
    localStorage.removeItem(DONE_KEY);
    setDismissed(false);
  };

  return {
    shouldShow,
    providers,
    checks,
    hasProvider,
    hasWorkspace,
    googleConnected,
    googleReady,
    doctor,
    doctorOk,
    allCoreDone,
    requiredDone,
    dismissed,
    isLoading: providersQ.isLoading,
    skip,
    markDone,
    resetDismissed,
  };
}
