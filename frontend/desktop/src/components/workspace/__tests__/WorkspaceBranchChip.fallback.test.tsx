import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Bug 5: the branch selector must also serve sessions WITHOUT a bound folder.
// WorkspaceBranchChip falls back to the app's current workspace path and only
// hides when nothing resolves to a git work tree.

const branchSpy = vi.fn();
vi.mock('@/api/git', () => ({
  gitApi: {
    branch: (...args: unknown[]) => branchSpy(...args),
    branches: vi.fn().mockResolvedValue({ workspace: null, branches: [] }),
    checkout: vi.fn().mockResolvedValue({ workspace: null, sha: '', output: '' }),
  },
}));

import { WorkspaceBranchChip } from '../WorkspaceBranchChip';
import { useWorkspacesStore } from '@/store/workspaces';

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('WorkspaceBranchChip — workspace fallback (Bug 5)', () => {
  beforeEach(() => {
    branchSpy.mockReset();
    useWorkspacesStore.setState({ workspaces: [], currentWorkspaceId: null });
  });

  it('falls back to the current workspace path when no repoPath/session is bound', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'ws1', name: 'proj', path: '/ws/proj', lastUsedAt: new Date().toISOString() },
      ],
      currentWorkspaceId: 'ws1',
    });
    branchSpy.mockResolvedValue({ workspace: '/ws/proj', current: 'main' });

    const { container } = render(<WorkspaceBranchChip sessionId={null} repoPath={undefined} />, {
      wrapper: makeWrapper(),
    });

    await waitFor(() => {
      expect(branchSpy).toHaveBeenCalledWith(undefined, '/ws/proj');
    });
    await waitFor(() => {
      expect(screen.getByText('main')).toBeTruthy();
    });
    expect(container.firstChild).not.toBeNull();
  });

  it('hides entirely when nothing resolves to a workspace', () => {
    branchSpy.mockResolvedValue({ workspace: null, current: null });
    const { container } = render(<WorkspaceBranchChip sessionId={null} repoPath={undefined} />, {
      wrapper: makeWrapper(),
    });
    // enabled=false → returns null without querying.
    expect(container.firstChild).toBeNull();
    expect(branchSpy).not.toHaveBeenCalled();
  });
});
