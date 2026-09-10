/* ── ComposerWorkspaceChips — folder + branch row inside the composer ── */
/* ZCode parity: the message box itself selects the project folder and    */
/* shows its git branch. Covers the folder menu, the bind flow (store +   */
/* backend workspace sync + git cache invalidation) and the native picker. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ComposerWorkspaceChips } from '../ComposerWorkspaceChips';
import { useWorkspacesStore } from '@/store/workspaces';

const branchMock = vi.fn();
const bindMock = vi.fn();
const pickMock = vi.fn();

vi.mock('@/api/git', () => ({
  gitApi: {
    branch: (...a: unknown[]) => branchMock(...a),
    branches: vi.fn(async () => ({ workspace: null, branches: [] })),
    status: vi.fn(async () => ({ workspace: null, files: [], added: 0, removed: 0 })),
    checkout: vi.fn(async () => ({ workspace: null, branch: '', ok: true })),
    log: vi.fn(async () => ({ workspace: null, log: '' })),
  },
}));

vi.mock('@/api/folder', () => ({
  openFolderViaTauri: (...a: unknown[]) => pickMock(...a),
  folderNameFromPath: (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace',
}));

vi.mock('@/store/sessions', () => ({
  bindSessionToWorkspacePath: (...a: unknown[]) => bindMock(...a),
}));

function setup(ui = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <ComposerWorkspaceChips
      sessionId="session_1"
      workbenchSessionId="wb_1"
      workspacePath="C:/Dev/august-proxy"
      {...ui}
    />,
    { wrapper },
  );
}

describe('ComposerWorkspaceChips', () => {
  beforeEach(() => {
    branchMock.mockReset();
    bindMock.mockReset();
    pickMock.mockReset();
    branchMock.mockResolvedValue({ workspace: 'C:/Dev/august-proxy', current: 'master' });
    bindMock.mockReturnValue({
      session: { id: 'session_1', workbenchSessionId: 'wb_1', workspacePath: 'C:/Dev/other' },
      created: false,
      folderCreated: false,
    });
    useWorkspacesStore.setState({
      workspaces: [
        { id: 'w1', name: 'august-proxy', path: 'C:/Dev/august-proxy', lastUsedAt: '2026-09-01T00:00:00Z' },
        { id: 'w2', name: 'agentic', path: 'C:/Dev/Agentic-Trading', lastUsedAt: '2026-09-07T00:00:00Z' },
      ],
      currentWorkspaceId: 'w1',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response),
    );
  });

  it('shows the bound folder name and its branch', async () => {
    setup();
    expect(screen.getByTestId('composer-folder-chip').textContent).toContain('august-proxy');
    await waitFor(() => expect(branchMock).toHaveBeenCalled());
    // waitFor passing on "called" does not mean the resolved value has
    // settled into the query yet — assert the render after it lands, not
    // synchronously (this raced since the 30s refetchInterval was added).
    await waitFor(() => expect(screen.getByText('master')).toBeTruthy());
  });

  it('falls back to "Open folder" when the chat has no workspace', () => {
    setup({ workspacePath: null });
    expect(screen.getByTestId('composer-folder-chip').textContent).toContain('Open folder');
  });

  it('lists known projects and re-binds the chat on pick', async () => {
    setup();
    fireEvent.click(screen.getByTestId('composer-folder-chip'));
    const menu = await screen.findByTestId('composer-folder-menu');
    const rows = [...menu.querySelectorAll('[data-testid="composer-folder-pick"]')] as HTMLElement[];
    // Most recently used first.
    expect(rows[0].textContent).toContain('C:/Dev/Agentic-Trading');
    fireEvent.click(rows[0]);
    await waitFor(() =>
      expect(bindMock).toHaveBeenCalledWith('session_1', 'C:/Dev/Agentic-Trading'),
    );
    // The backend workbench session gets the new workspace so tools + prompt agree.
    const post = vi
      .mocked(fetch)
      .mock.calls.find(([u]) => String(u) === '/api/workbench/sandbox-mode');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      sessionId: 'wb_1',
      workspacePath: 'C:/Dev/other',
    });
  });

  it('opens the native folder picker from the menu', async () => {
    pickMock.mockResolvedValue({ path: 'C:/Dev/new-repo', name: 'new-repo', cancelled: false });
    setup();
    fireEvent.click(screen.getByTestId('composer-folder-chip'));
    fireEvent.click(await screen.findByTestId('composer-open-folder'));
    await waitFor(() => expect(pickMock).toHaveBeenCalled());
    await waitFor(() => expect(bindMock).toHaveBeenCalledWith('session_1', 'C:/Dev/new-repo'));
  });

  it('does nothing when the picker is cancelled', async () => {
    pickMock.mockResolvedValue({ path: null, name: null, cancelled: true });
    setup();
    fireEvent.click(screen.getByTestId('composer-folder-chip'));
    fireEvent.click(await screen.findByTestId('composer-open-folder'));
    await waitFor(() => expect(pickMock).toHaveBeenCalled());
    expect(bindMock).not.toHaveBeenCalled();
  });
});
