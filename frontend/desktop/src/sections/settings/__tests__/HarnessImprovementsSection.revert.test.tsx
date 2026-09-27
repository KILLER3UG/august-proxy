/* ── Review inbox: measured-regression rows (audit P1#9) ──────────────────── */
/* The outcome ledger files a `revert` proposal when a learning write measures
 * as a regression. That row is the one entry in this queue carrying evidence
 * of harm, so it is pinned above the recency order and tagged as such. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

/** One regression row, deliberately the OLDEST of the three. */
const REGRESSION = {
  id: 'prop_revert',
  createdAt: '2026-09-01T00:00:00Z',
  kind: 'revert',
  status: 'open' as const,
  problem: 'revert the circuit-sim skill?',
  evidence: '{"verdict":"regressed"}',
  proposal: 'Revert the change booked as outcome proposal:prop_orig',
  rollback: 'delete the circuit-sim skill directory',
  payload: { outcomeId: 7, outcomeKey: 'proposal:prop_orig' },
};

const NEWER = {
  id: 'prop_b',
  createdAt: '2026-09-20T00:00:00Z',
  kind: 'skill_create',
  status: 'open' as const,
  problem: 'newest ordinary row',
  evidence: 'e',
  proposal: 'p',
  rollback: 'r',
};

const OLDER = {
  id: 'prop_a',
  createdAt: '2026-09-10T00:00:00Z',
  kind: 'brain_config',
  status: 'open' as const,
  problem: 'middle ordinary row',
  evidence: 'e',
  proposal: 'p',
  rollback: 'r',
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.includes('inbox/count')) return Promise.resolve({ open: 1 });
    if (url.startsWith('/api/harness/proposals')) {
      return Promise.resolve({
        ok: true,
        openCount: 3,
        proposals: [NEWER, OLDER, REGRESSION],
      });
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

describe('measured-regression rows', () => {
  it('pins a revert row above newer ordinary rows', async () => {
    renderSection();
    const regression = await screen.findByText('revert the circuit-sim skill?');
    const newer = screen.getByText('newest ordinary row');
    // DOCUMENT_POSITION_FOLLOWING === the regression precedes the newer row.
    expect(regression.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and ordinary rows keep their own newest-first order.
    const middle = screen.getByText('middle ordinary row');
    expect(newer.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('tags the row as a measured regression', async () => {
    renderSection();
    const tags = await screen.findAllByTestId('measured-regression-tag');
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0].textContent).toContain('measured regression');
  });
});
