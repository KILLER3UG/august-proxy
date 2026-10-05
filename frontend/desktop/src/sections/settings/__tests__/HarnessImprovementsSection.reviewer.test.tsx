/* ── Review inbox: the reviewer's one line (handoff §5) ──────────────────────
 * The reviewer pass records a verdict on every open skill proposal. The inbox
 * must show it, because a proposal the human cannot see reviewed is a
 * proposal they will re-read from scratch. One muted line, in the existing
 * detail header — no new section, no new colors.
 *
 * The SHAPE of the line is the backend's: `review_summary()` in
 * harness_self_improve.py is the source of these exact prefixes, and it is
 * pinned there by test_reviewer_pass.py. If either side changes the wording,
 * a test on that side fails and points at the other.
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

const base = {
  createdAt: '2026-10-01T00:00:00Z',
  kind: 'skill_patch',
  status: 'open' as const,
  evidence: 'e',
  proposal: 'p',
  rollback: 'r',
};

const KEEP = {
  ...base,
  id: 'prop_keep',
  problem: 'a proposal the reviewer approved',
  review: {
    verdict: 'KEEP',
    reason: 'the gap is real and durable',
    model: 'claude-sonnet-5',
    advisory: true,
  },
};

const UNAVAILABLE = {
  ...base,
  id: 'prop_unavailable',
  problem: 'a proposal no reviewer could judge',
  review: {
    verdict: 'unavailable',
    reason: 'no reviewer model available',
    model: '',
    advisory: true,
  },
};

const UNREVIEWED = { ...base, id: 'prop_bare', problem: 'a proposal never reviewed' };

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.includes('inbox/count')) return Promise.resolve({ open: 3 });
    if (url.startsWith('/api/harness/proposals')) {
      return Promise.resolve({
        ok: true,
        openCount: 3,
        proposals: [KEEP, UNAVAILABLE, UNREVIEWED],
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

const openDetail = async (problem: string) => {
  renderSection();
  const row = await screen.findByText(problem);
  fireEvent.click(row);
  return screen.findByTestId('reviewer-line');
};

describe('the reviewer line in the inbox', () => {
  it('shows a keep verdict as one muted line', async () => {
    const line = await openDetail('a proposal the reviewer approved');
    expect(line.textContent).toBe('Reviewer: keep — the gap is real and durable');
    expect(line.className).toContain('text-muted-foreground');
  });

  it('names the cause when no reviewer was available', async () => {
    const line = await openDetail('a proposal no reviewer could judge');
    expect(line.textContent).toBe('Reviewer unavailable — no reviewer model available');
  });

  it('renders nothing for a proposal the reviewer never saw', async () => {
    renderSection();
    const row = await screen.findByText('a proposal never reviewed');
    fireEvent.click(row);
    // The detail header is up (the back control only exists there)…
    await screen.findByText('Back to inbox');
    // …and it carries no reviewer line.
    expect(screen.queryByTestId('reviewer-line')).toBeNull();
  });
});
