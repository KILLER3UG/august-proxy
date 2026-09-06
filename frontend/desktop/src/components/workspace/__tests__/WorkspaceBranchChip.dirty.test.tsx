import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Branch-switching with uncommitted changes must offer the GitHub-style
// choice (bring / leave) instead of failing the switch outright.

const checkoutSpy = vi.fn();
vi.mock('@/api/git', () => ({
  gitApi: {
    branches: vi.fn().mockResolvedValue({
      workspace: '/ws',
      branches: [{ name: 'main', current: true }, { name: 'feature', current: false }],
    }),
    status: vi.fn().mockResolvedValue({ workspace: '/ws', files: [], added: 0, removed: 0 }),
    checkout: (...args: unknown[]) => checkoutSpy(...args),
  },
}));

import { BranchMenuBody } from '../WorkspaceBranchChip';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('BranchMenuBody — dirty switch prompt', () => {
  beforeEach(() => checkoutSpy.mockReset());

  it('shows leave/transfer when the switch is blocked, then transfers', async () => {
    checkoutSpy
      .mockResolvedValueOnce({ ok: false, dirty: true, branch: 'feature', files: ['a.txt'] })
      .mockResolvedValueOnce({ ok: true, branch: 'feature', stashed: true, carried: true });

    render(<BranchMenuBody sessionId="s1" repoPath="/ws" current="main" />, { wrapper });

    const featureBtn = await screen.findByRole('option', { name: /feature/ });
    fireEvent.click(featureBtn);

    // The blocked switch surfaces the prompt instead of an error toast.
    const prompt = await screen.findByTestId('branch-dirty-prompt');
    expect(prompt.textContent).toContain('a.txt');

    fireEvent.click(screen.getByTestId('branch-transfer'));

    await waitFor(() => {
      expect(checkoutSpy).toHaveBeenLastCalledWith('s1', 'feature', '/ws', false, 'transfer');
    });
  });

  it('leaves changes (stash) when Leave here is chosen', async () => {
    checkoutSpy
      .mockResolvedValueOnce({ ok: false, dirty: true, branch: 'feature', files: [] })
      .mockResolvedValueOnce({ ok: true, branch: 'feature', stashed: true });

    render(<BranchMenuBody sessionId="s1" repoPath="/ws" current="main" />, { wrapper });
    fireEvent.click(await screen.findByRole('option', { name: /feature/ }));
    fireEvent.click(await screen.findByTestId('branch-leave'));

    await waitFor(() => {
      expect(checkoutSpy).toHaveBeenLastCalledWith('s1', 'feature', '/ws', false, 'leave');
    });
  });

  it('switches straight through when not dirty', async () => {
    checkoutSpy.mockResolvedValueOnce({ ok: true, branch: 'feature' });
    const onDone = vi.fn();
    render(<BranchMenuBody sessionId="s1" repoPath="/ws" current="main" onDone={onDone} />, { wrapper });
    fireEvent.click(await screen.findByRole('option', { name: /feature/ }));

    await waitFor(() => {
      expect(checkoutSpy).toHaveBeenCalledWith('s1', 'feature', '/ws');
    });
    expect(await screen.queryByTestId('branch-dirty-prompt')).toBeNull();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
