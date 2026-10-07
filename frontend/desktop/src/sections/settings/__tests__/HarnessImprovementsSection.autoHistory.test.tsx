/* ── Review inbox: the record of what the machine changed by itself ─────────
 * Item 14 requires a readable history of auto-applied changes, settings only.
 * It lives inside the existing inbox as one disclosure, not a new section: a
 * list of changes August made is part of the same question the inbox already
 * answers ("what happened to my agent while I wasn't looking").
 *
 * Two rules these tests hold:
 *   * nothing renders when there is no history — an empty "August has changed
 *     nothing" block is decoration, and the switch state is already the answer;
 *   * rows are labelled by what a human recognises (the skill and a date), and
 *     the proposal id never becomes the label.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const HISTORY = {
  autonomy: true,
  changes: [
    {
      at: '2026-10-04T09:12:00Z',
      proposalId: 'prop_20261004_aaaabbbb',
      skill: 'ngspice-flow',
      versionTs: '1791234567',
      reverted: false,
    },
    {
      at: '2026-10-01T18:04:00Z',
      proposalId: 'prop_20261001_ccccdddd',
      skill: 'quartus-build',
      versionTs: '1791111111',
      reverted: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockImplementation((url: string) => {
    if (url.includes('inbox/count')) return Promise.resolve({ harness: 0, memory: 0, total: 0 });
    if (url.includes('auto-history')) return Promise.resolve(HISTORY);
    if (url.startsWith('/api/harness/proposals')) {
      return Promise.resolve({ ok: true, openCount: 0, proposals: [] });
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

describe('the auto-change history', () => {
  it('lists each change by skill and date, not by its id', async () => {
    renderSection();
    const block = await screen.findByTestId('auto-change-history');
    expect(block.textContent).toContain('ngspice-flow');
    expect(block.textContent).toContain('quartus-build');
    expect(block.textContent).not.toContain('prop_20261004_aaaabbbb');
  });

  it('marks the change probation put back, and only that one', async () => {
    renderSection();
    const block = await screen.findByTestId('auto-change-history');
    const rows = screen.getAllByTestId('auto-change-row');
    expect(rows).toHaveLength(2);
    const revertedRow = rows.find((r) => r.textContent?.includes('quartus-build'));
    const liveRow = rows.find((r) => r.textContent?.includes('ngspice-flow'));
    expect(revertedRow?.textContent).toMatch(/restored/i);
    expect(liveRow?.textContent).not.toMatch(/restored/i);
    expect(block).toBeInTheDocument();
  });

  it('says which way the switch is set', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve({ ...HISTORY, autonomy: false });
      return beforeEachDefault(url);
    });
    renderSection();
    const block = await screen.findByTestId('auto-change-history');
    expect(block.textContent).toMatch(/off/);
  });

  it('renders nothing at all when August has never changed anything by itself', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve({ autonomy: false, changes: [] });
      return beforeEachDefault(url);
    });
    renderSection();
    await screen.findByText('Review Inbox');
    expect(screen.queryByTestId('auto-change-history')).toBeNull();
  });
});

/** The non-history endpoints, for the tests that override only one URL. */
function beforeEachDefault(url: string): Promise<unknown> {
  if (url.includes('inbox/count')) return Promise.resolve({ harness: 0, memory: 0, total: 0 });
  if (url.startsWith('/api/harness/proposals')) {
    return Promise.resolve({ ok: true, openCount: 0, proposals: [] });
  }
  if (url.startsWith('/api/august/memory/proposals')) {
    return Promise.resolve({ ok: true, proposals: [] });
  }
  return Promise.resolve({});
}

/* The page's own promise has to track the switch. Before item 14 the header
 * could say "Nothing applies until you approve it" unconditionally; now that is
 * only true while autonomy is off, and a settings page that misdescribes when
 * its own machinery writes is worse than one that says nothing. */
describe('the header states what the switch means', () => {
  /** The header's first paint is the off-state sentence, so "it says the right
   *  thing" only means something after the switch read has landed. */
  const waitForHistoryRead = async () => {
    await waitFor(() =>
      expect(
        getMock.mock.calls.some((c) => String(c[0]).includes('auto-history')),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId('inbox-header-note')).toBeInTheDocument());
  };

  it('promises human approval while autonomy is off', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve({ autonomy: false, changes: [] });
      return beforeEachDefault(url);
    });
    renderSection();
    await waitForHistoryRead();
    const header = screen.getByTestId('inbox-header-note');
    expect(header.textContent).toMatch(/nothing applies until you approve/i);
    expect(header.textContent).not.toMatch(/on their own/i);
  });

  it('says the machine applies changes while autonomy is on', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve(HISTORY);
      return beforeEachDefault(url);
    });
    renderSection();
    const header = await screen.findByTestId('inbox-header-note');
    await waitFor(() =>
      expect(header.textContent).toMatch(/apply qualifying skill changes on their own/i),
    );
    expect(header.textContent).not.toMatch(/nothing applies until you approve/i);
  });
});

/* ── The shadow readout (review item 1) ─────────────────────────────────────
 * A rehearsal is not a change. The panel has to say which is which, because the
 * whole point of shadow mode is reading what the rails would have done — and a
 * list that mixes "applied" with "would have applied" is how a dry run comes to
 * look like it wrote something.
 */
const SHADOW = [
  {
    at: '2026-10-05T10:00:00Z',
    proposalId: 'prop_shadow_a',
    kind: 'skill_patch',
    skill: 'would-have-applied',
    verdict: 'KEEP',
    wouldApply: true,
    heldBy: '',
    reason: '',
    rails: [{ rule: 'autonomy-off', passed: true }],
  },
  {
    at: '2026-10-05T09:00:00Z',
    proposalId: 'prop_shadow_b',
    kind: 'skill_create',
    skill: 'was-held',
    verdict: 'KEEP',
    wouldApply: false,
    heldBy: 'untrusted-evidence',
    reason: 'the evidence quotes a fetchable URL',
    rails: [
      { rule: 'untrusted-evidence', passed: false },
      { rule: 'unsafe-content', passed: true },
    ],
  },
];

describe('the shadow readout', () => {
  it('says which rehearsals would have applied and which rail held the rest', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve({ autonomy: true, changes: [], shadow: SHADOW });
      return beforeEachDefault(url);
    });
    renderSection();
    // Await the panel itself so the rows below are certainly mounted.
    await screen.findByTestId('auto-change-history');
    const rows = screen.getAllByTestId('shadow-decision-row');
    expect(rows).toHaveLength(2);
    const applied = rows.find((r) => r.textContent?.includes('would-have-applied'));
    const held = rows.find((r) => r.textContent?.includes('was-held'));
    expect(applied?.textContent).toMatch(/would have applied/i);
    expect(held?.textContent).toMatch(/untrusted-evidence/);
    expect(held?.textContent).not.toMatch(/would have applied/i);
  });

  it('shows the readout even when nothing was ever applied', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) return Promise.resolve({ autonomy: true, changes: [], shadow: SHADOW });
      return beforeEachDefault(url);
    });
    renderSection();
    const block = await screen.findByTestId('auto-change-history');
    // The changes count is absent rather than zero-with-decoration...
    expect(block.textContent).not.toMatch(/applied by itself/);
    // ...while the rehearsals are listed.
    expect(block.textContent).toMatch(/shadow/i);
  });

  it('keeps a rehearsal out of the applied count', async () => {
    const applied = {
      at: '2026-10-04T09:12:00Z',
      proposalId: 'prop_real_change',
      skill: 'ngspice-flow',
      versionTs: '1791234567',
      created: false,
      reverted: false,
    };
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) {
        return Promise.resolve({ autonomy: true, changes: [applied], shadow: SHADOW });
      }
      return beforeEachDefault(url);
    });
    renderSection();
    const block = await screen.findByTestId('auto-change-history');
    expect(block.textContent).toMatch(/1 change applied by itself/);
    // 1 real + 2 rehearsals must never read as three changes.
    expect(block.textContent).not.toMatch(/3 changes applied by itself/);
    expect(block.textContent).toMatch(/2 shadow decisions/);
  });
});
