/* AgentSandboxSection — the truthfulness contract in the Settings UI.
 *
 * A sandbox tier may never be presented as active when it is not. The case
 * that matters: the user opted into a strong tier (container / AppContainer),
 * the host could not provide it, and the panel must say so in plain language
 * instead of showing a healthy-looking backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { workbenchClient } from '@/api/workbench/WorkbenchClient';
import { AgentSandboxSection } from '../AgentSandboxSection';

vi.mock('@/api/workbench/WorkbenchClient', () => ({
  workbenchClient: { doctor: vi.fn() },
}));

type SandboxCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  backend?: string;
  requested?: string;
  strong?: boolean;
  degraded?: boolean;
  reason?: string;
};

function doctorWith(check: SandboxCheck) {
  vi.mocked(workbenchClient.doctor).mockResolvedValue({
    ok: true,
    checks: [check],
    summary: '1/1 checks healthy',
  });
}

const base = {
  id: 'sandbox',
  label: 'Agent sandbox',
  ok: true,
  detail: '',
};

describe('AgentSandboxSection enforcement honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks soft enforcement as NOT OS isolation', async () => {
    doctorWith({
      ...base,
      detail: 'Soft policy (cwd + network/path guards) — not OS isolation',
      backend: 'soft',
      requested: 'soft',
      strong: false,
      degraded: false,
      reason: 'no OS-level sandbox tier is enabled on this host',
    });
    render(<AgentSandboxSection />);
    await waitFor(() => expect(screen.getByTestId('sandbox-backend')).toHaveTextContent('soft'));
    expect(screen.getByTestId('sandbox-strength')).toHaveTextContent('Not OS isolation');
    expect(screen.queryByTestId('sandbox-degraded')).not.toBeInTheDocument();
  });

  it('surfaces a requested-but-unavailable tier instead of showing it healthy', async () => {
    doctorWith({
      ...base,
      ok: false,
      detail: 'Soft policy · requested container but inactive: docker daemon is not answering',
      backend: 'soft',
      requested: 'container',
      strong: false,
      degraded: true,
      reason: 'docker daemon is not answering (start Docker Desktop)',
    });
    render(<AgentSandboxSection />);
    await waitFor(() => expect(screen.getByTestId('sandbox-degraded')).toBeInTheDocument());
    const banner = screen.getByTestId('sandbox-degraded');
    expect(banner).toHaveTextContent('container');
    expect(banner).toHaveTextContent('soft');
    expect(banner).toHaveTextContent('docker daemon is not answering');
    expect(banner).toHaveTextContent('not a security boundary');
  });

  it('reports a working strong backend as OS isolation', async () => {
    doctorWith({
      ...base,
      detail: 'Linux bubblewrap · default workspace-write',
      backend: 'bwrap',
      requested: 'soft',
      strong: true,
      degraded: false,
      reason: '',
    });
    render(<AgentSandboxSection />);
    await waitFor(() => expect(screen.getByTestId('sandbox-strength')).toHaveTextContent('OS isolation'));
    expect(screen.queryByTestId('sandbox-degraded')).not.toBeInTheDocument();
    // The warm kernel bypass note belongs with a strong backend.
    expect(screen.getByText(/warm interpreter is\s+switched off/i)).toBeInTheDocument();
  });

  it('does not crash when the doctor report omits sandbox fields', async () => {
    vi.mocked(workbenchClient.doctor).mockResolvedValue({
      ok: true,
      checks: [{ id: 'backend', label: 'Backend', ok: true, detail: 'up' }],
      summary: '1/1',
    });
    render(<AgentSandboxSection />);
    await waitFor(() => expect(screen.getByTestId('sandbox-backend')).toHaveTextContent('soft'));
  });
});
