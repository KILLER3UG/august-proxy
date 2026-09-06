/* ── ChangesPill — git cluster in the chat corner ─────────────────────── */
/* Covers the reference-parity cluster: pill totals, Git tools popover     */
/* (file list, branch drill-in with create), and the commit modal actions. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChangesPill } from '../ChangesPill';

vi.mock('@/api/git', () => ({
  gitApi: {
    status: vi.fn(async () => ({
      workspace: '/repo',
      added: 65,
      removed: 85,
      files: [
        { path: 'backend-py/app/services/workbench.py', status: 'M', added: 60, removed: 80 },
        { path: 'frontend/new.ts', status: '??', added: 5, removed: 5 },
      ],
    })),
    branch: vi.fn(async () => ({ workspace: '/repo', current: 'master' })),
    branches: vi.fn(async () => ({
      workspace: '/repo',
      branches: [
        { name: 'master', current: true },
        { name: 'feat/other', current: false },
      ],
    })),
    commit: vi.fn(async () => ({ workspace: '/repo', sha: 'abc1234', output: 'ok' })),
    push: vi.fn(async () => ({ workspace: '/repo', output: 'To origin' })),
    checkout: vi.fn(async () => ({ workspace: '/repo', sha: '', output: '', branch: 'fresh-work' })),
    log: vi.fn(async () => ({ workspace: '/repo', log: 'abc1234 fix thing' })),
    diff: vi.fn(async () => ({ workspace: '/repo', added: 0, removed: 0, files: [] })),
    command: vi.fn(async () => ({ workspace: '/repo', output: '' })),
  },
}));

import { gitApi } from '@/api/git';

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ChangesPill
        sessionId="sess1"
        roster={[{ jobId: 'j1', agentId: 'alpha', task: 'scan repo', status: 'running' }]}
      />
    </QueryClientProvider>,
  );
}

describe('ChangesPill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks resets the resolved values to `undefined`; the rest of
    // the suite needs the defaults (2 files, master branch, etc.) reapplied.
    vi.mocked(gitApi.status).mockResolvedValue({
      workspace: '/repo',
      added: 65,
      removed: 85,
      files: [
        { path: 'backend-py/app/services/workbench.py', status: 'M', added: 60, removed: 80 },
        { path: 'frontend/new.ts', status: '??', added: 5, removed: 5 },
      ],
    });
    vi.mocked(gitApi.branch).mockResolvedValue({ workspace: '/repo', current: 'master' });
    vi.mocked(gitApi.branches).mockResolvedValue({
      workspace: '/repo',
      branches: [
        { name: 'master', current: true },
        { name: 'feat/other', current: false },
      ],
    });
  });

  it('hides the pill when the workspace has no changes', async () => {
    const mocked = vi.mocked(gitApi.status);
    mocked.mockResolvedValue({ workspace: '/repo', added: 0, removed: 0, files: [] });
    setup();
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(screen.queryByTestId('changes-pill')).toBeNull();
  });

  it('renders totals and opens the Git tools popover', async () => {
    setup();
    const pill = await screen.findByTestId('changes-pill');
    expect(pill.textContent).toContain('Changes');
    expect(pill.textContent).toContain('+65');
    expect(pill.textContent).toContain('-85');
    fireEvent.click(pill);
    expect(await screen.findByTestId('git-tools-popover')).toBeTruthy();
    expect(screen.getByTestId('git-tools-branch').textContent).toContain('master');
    expect(screen.getByTestId('git-tools-commit')).toBeTruthy();
  });

  it('expands the per-file change list', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('changes-pill'));
    fireEvent.click(await screen.findByTestId('git-tools-changes'));
    const files = await screen.findByTestId('git-tools-files');
    expect(files.textContent).toContain('workbench.py');
  });

  it('commits with the include-unstaged flag from the modal', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('changes-pill'));
    fireEvent.click(await screen.findByTestId('git-tools-commit'));
    const modal = await screen.findByTestId('commit-modal');
    expect(modal).toBeTruthy();
    const checkbox = screen.getByTestId('include-unstaged') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.change(screen.getByTestId('commit-message-input'), {
      target: { value: 'feat: test commit' },
    });
    fireEvent.click(screen.getByTestId('commit-action'));
    await waitFor(() =>
      expect(vi.mocked(gitApi.commit)).toHaveBeenCalledWith('sess1', 'feat: test commit', undefined, true),
    );
  });

  it('drills into the branch menu and creates a branch', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('changes-pill'));
    fireEvent.click(await screen.findByTestId('git-tools-branch'));
    expect(await screen.findByTestId('branch-menu-body')).toBeTruthy();
    expect(screen.getByTestId('branch-search')).toBeTruthy();
    fireEvent.click(screen.getByTestId('branch-create'));
    const input = screen.getByTestId('branch-create-input');
    fireEvent.change(input, { target: { value: 'fresh-work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(vi.mocked(gitApi.checkout)).toHaveBeenCalledWith('sess1', 'fresh-work', undefined, true),
    );
  });

  it('lists running agents in the popover', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('changes-pill'));
    const popover = await screen.findByTestId('git-tools-popover');
    expect(popover.textContent).toContain('scan repo');
    expect(popover.textContent).toContain('Agents');
  });
});
