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
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

// Only the two write helpers are faked. `getAutoApplyHistory` stays real so the
// chip still exercises the client it actually uses, against the mocked `api`.
vi.mock('@/api/api-client/skills-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api-client/skills-versions')>();
  return { ...actual, restoreSkillVersion: vi.fn(), disableSkill: vi.fn() };
});

import { api } from '@/api/client';
import { SkillEvolvedChip } from '../SkillEvolvedChip';
import { SkillReceiptChip } from '@/components/chat/SkillReceiptChip';
import { disableSkill, restoreSkillVersion } from '@/api/api-client/skills-versions';

const getMock = vi.mocked(api.get);
const deleteMock = vi.mocked(api.delete);
const restoreMock = vi.mocked(restoreSkillVersion);
const disableMock = vi.mocked(disableSkill);

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
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
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

  it('undoes a create by disabling the skill, never by deleting it', async () => {
    // A created skill has no earlier version to restore, so its undo is the
    // soft one through the existing enable/disable path. A delete would take
    // the user's file with it, which is not what "undo my announcement" means.
    getMock.mockImplementation((url: string) => {
      if (url.includes('auto-history')) {
        return Promise.resolve({
          autonomy: true,
          changes: [{ ...CHANGE, versionTs: '', created: true }],
        });
      }
      return Promise.resolve({});
    });
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    const button = within(chip).getByTestId('skill-evolved-undo');
    expect(button.textContent).toMatch(/disable/i);
    fireEvent.click(button);
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith('ngspice-flow'));
    expect(restoreMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('skill-evolved-chip')).toBeNull());
  });

  it('stays away once dismissed', async () => {
    renderChip();
    const chip = await screen.findByTestId('skill-evolved-chip');
    fireEvent.click(within(chip).getByTestId('skill-evolved-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('skill-evolved-chip')).toBeNull());

    renderChip();
    // act()-wrapped settling: a bare sleep lets the query resolve outside the
    // test's act scope, which React rightly complains about and which could
    // also hide an update-after-unmount.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
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

describe('the two skill notices are not the same notice', () => {
  /* A turn that wrote a SKILL.md itself renders a chip in the transcript, and
   * an autonomous apply renders the chip above the composer. Both are in the
   * document at once the moment autonomy is on — and they used to carry the
   * same name and the same data-testid, which made each unqueryable by a test
   * and indistinguishable to a reader. */
  it('each renders once when both are on screen', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SkillEvolvedChip />
        <SkillReceiptChip
          tools={[
            {
              id: 'w1',
              name: 'write_file',
              status: 'done',
              context: JSON.stringify({ filePath: '/home/u/.august/skills/tutor/SKILL.md' }),
            },
          ]}
        />
      </QueryClientProvider>,
    );

    // Await a control only the composer chip renders, so the assertion below
    // runs after its query has landed. findByTestId on the shared id would
    // resolve against the transcript chip alone while the composer is still
    // loading — which is a passing test that proves nothing.
    const undo = await screen.findByTestId('skill-evolved-undo');
    const announced = undo.closest('[data-testid="skill-evolved-chip"]');
    expect(announced?.textContent).toContain('by itself');

    expect(screen.getAllByTestId('skill-evolved-chip')).toHaveLength(1);

    const receipt = screen.getByTestId('skill-receipt-chip');
    expect(receipt.textContent).toContain('Skill updated: tutor');
    expect(receipt).not.toBe(announced);
  });
});
