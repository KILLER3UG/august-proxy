/* ── SkillEvolvedChip (item 15) ──────────────────────────────────────────────
 * Announces a skill August changed by itself, with the undo attached.
 *
 * Two rules these tests hold, both from the plan:
 *   * it never appears while autonomy is off — even for a change made when it
 *     was on. The settings history is the record for those; a chip in the chat
 *     column is an announcement about what the machine is doing NOW;
 *   * a change a human approved is not here at all (the backend only records
 *     reviewer-applied changes — see test_harness_probation's announcement
 *     class), so the chip has nothing to say about human work.
 *
 * The label is the skill, never the proposal id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

// Only `restoreSkillVersion` is faked. `getAutoApplyHistory` stays real so the
// chip still exercises the client it actually uses, against the mocked `api`.
vi.mock('@/api/api-client/skills-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api-client/skills-versions')>();
  return { ...actual, restoreSkillVersion: vi.fn() };
});

import { api } from '@/api/client';
import { SkillEvolvedChip } from '../SkillEvolvedChip';
import { restoreSkillVersion } from '@/api/api-client/skills-versions';

const getMock = vi.mocked(api.get);
const restoreMock = vi.mocked(restoreSkillVersion);

const CHANGE = {
  at: '2026-10-04T09:12:00Z',
  proposalId: 'prop_20261004_aaaabbbb',
  skill: 'ngspice-flow',
  versionTs: '1791234567',
  reverted: false,
};

const historyResponse = (over: Record<string, unknown> = {}) => ({
  autonomy: true,
  changes: [CHANGE, ...((over.extra as object[]) ?? [])],
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getMock.mockImplementation((url: string) => {
    if (url.includes('auto-history')) return Promise.resolve(historyResponse());
    return Promise.resolve({});
  });
  restoreMock.mockResolvedValue({ ok: true, name: 'ngspice-flow', restored: '1791234567', skill: {} });
});

const renderChip = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SkillEvolvedChip />
    </QueryClientProvider>,
  );
};

describe('SkillEvolvedChip', () => {
  it('names the skill it changed and offers the undo', async () => {
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    expect(chip.textContent).toContain('ngspice-flow');
    expect(chip.textContent).not.toContain('prop_20261004_aaaabbbb');
    expect(within(chip).getByTestId('skill-evolved-undo').textContent).toMatch(/undo/i);
  });

  it('never appears while autonomy is off', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) {
        return Promise.resolve({ autonomy: false, changes: [CHANGE] });
      }
      return Promise.resolve({});
    });
    renderChip();
    // The query has landed — the chip would render now if it were going to.
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('skill-evolved-chip')).toBeNull();
  });

  it('restores the version it names, then stops announcing it', async () => {
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    fireEvent.click(within(chip).getByTestId('skill-evolved-undo'));
    await waitFor(() =>
      // Two args: the chip announces global skill changes, so it has no
      // workspace to scope the restore to.
      expect(restoreMock).toHaveBeenCalledWith('ngspice-flow', '1791234567'),
    );
    await waitFor(() => expect(screen.queryByTestId('skill-evolved-chip')).toBeNull());
  });

  it('announces a change it cannot undo, without pretending it can', async () => {
    // A created skill has no previous version to put back — the honest chip
    // says what happened and offers no undo rather than inventing a write.
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) {
        return Promise.resolve({
          autonomy: true,
          changes: [{ ...CHANGE, versionTs: '' }],
        });
      }
      return Promise.resolve({});
    });
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    expect(chip.textContent).toContain('ngspice-flow');
    expect(within(chip).queryByTestId('skill-evolved-undo')).toBeNull();
  });

  it('stays away once dismissed', async () => {
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    fireEvent.click(within(chip).getByTestId('skill-evolved-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('skill-evolved-chip')).toBeNull());

    renderChip();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('skill-evolved-chip')).toBeNull();
  });

  it('opens to say when, and that probation put it back', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) {
        return Promise.resolve({
          autonomy: true,
          changes: [CHANGE, { ...CHANGE, proposalId: 'prop_old', skill: 'quartus-build', reverted: true }],
        });
      }
      return Promise.resolve({});
    });
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    fireEvent.click(within(chip).getByTestId('skill-evolved-expand'));
    const details = await screen.findByTestId('skill-evolved-details');
    // The newest change is the one being announced; the list is its context.
    expect(details.textContent).toContain('quartus-build');
    expect(details.textContent).toMatch(/restored/i);
  });
});
