/* ── Review inbox: the archive proposal is approvable (2026-10-10) ──────────
 * The skill lifecycle's second half files a `retire`-shaped proposal whose
 * approval MOVES a skill into the delete trash. The inbox's APPROVABLE set
 * is the door: a kind missing from it renders "human-only — records
 * findings" and disables Approve, which is a lie about any approvable kind.
 * `retire` and `promote` were in exactly that position — approvable in the
 * backend `_APPROVERS` registry, unapprovable here — and `archive` must not
 * join them.
 *
 * Pinned: the badge is absent for these kinds, the Approve button is live,
 * and clicking it posts the decision to the harness route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { HarnessImprovementsSection } from '../HarnessImprovementsSection';

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);

const base = {
  createdAt: '2026-10-10T00:00:00Z',
  status: 'open' as const,
  evidence: 'e',
  proposal: 'p',
  rollback: 'r',
};

const proposal = (kind: string, problem: string, id: string) => ({ ...base, id, kind, problem });

const CASES: Array<[kind: string, problem: string, id: string]> = [
  ['archive', 'Skill dead-skill has been retired and unused for 60+ days', 'prop_archive'],
  ['retire', 'Skill dead-skill has no measured effect', 'prop_retire'],
  ['promote', 'A pattern seen across two projects', 'prop_promote'],
];

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.includes('inbox/count')) return Promise.resolve({ open: CASES.length });
    if (url.startsWith('/api/harness/proposals')) {
      return Promise.resolve({ ok: true, openCount: CASES.length, proposals: CASES.map((c) => proposal(...c)) });
    }
    if (url.startsWith('/api/august/memory/proposals')) {
      return Promise.resolve({ ok: true, proposals: [] });
    }
    return Promise.resolve({});
  });
});

const renderSection = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HarnessImprovementsSection />
    </QueryClientProvider>,
  );
};

describe.each(CASES)('the %s proposal in the inbox', (kind, problem, id) => {
  it('is offered as approvable, not as human-only records', async () => {
    renderSection();
    fireEvent.click(await screen.findByText(problem));
    await screen.findByText('Back to inbox');
    expect(screen.queryByTestId('measured-regression-tag')).toBeNull();
    const approve = screen.getByTestId('proposal-approve');
    expect(approve.matches(':disabled')).toBe(false);
    expect(approve.getAttribute('title')).toContain(kind === 'archive' ? 'delete trash' : 'applier');
  });

  it('posts the decision to the harness route', async () => {
    postMock.mockResolvedValue({ ok: true });
    renderSection();
    fireEvent.click(await screen.findByText(problem));
    fireEvent.click(screen.getByTestId('proposal-approve'));
    await vi.waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(`/api/harness/proposals/${id}/decide`, expect.anything()),
    );
  });
});

describe('an applied archive', () => {
  beforeEach(() => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('inbox/count')) return Promise.resolve({ open: 0 });
      if (url.startsWith('/api/harness/proposals')) {
        return Promise.resolve({
          ok: true,
          openCount: 0,
          proposals: [
            {
              ...base,
              id: 'prop_archive_done',
              kind: 'archive',
              status: 'applied',
              problem: 'Skill gone-skill has been retired and unused for 60+ days',
              applyResult: {
                ok: true,
                action: 'archived',
                name: 'gone-skill',
                trashId: '20261010T101010101010',
              },
            },
          ],
        });
      }
      if (url.startsWith('/api/august/memory/proposals')) {
        return Promise.resolve({ ok: true, proposals: [] });
      }
      return Promise.resolve({});
    });
  });

  it('offers the trash id and the restore route beside the decision', async () => {
    postMock.mockResolvedValue({ restored: 'gone-skill' });
    renderSection();
    fireEvent.click(await screen.findByText('Skill gone-skill has been retired and unused for 60+ days'));
    const button = await screen.findByTestId('proposal-restore-archive');
    expect(screen.getByText('20261010T101010101010')).toBeTruthy();
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/skills/restore/20261010T101010101010'),
    );
  });
});
