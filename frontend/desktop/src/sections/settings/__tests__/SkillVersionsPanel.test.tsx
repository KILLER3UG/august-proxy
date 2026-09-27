/* ── SkillVersionsPanel test (audit #13) ────────────────────────────────
 * The list, the per-version selection, and the three honest outcomes the
 * diff pane has to keep apart: a real diff, an empty diff (this snapshot IS
 * the live file), and a failed request (which is not "no differences").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const versionsPayload: SkillVersionList = {
  versions: [
    {
      ts: '1780000000',
      actor: 'user',
      rationale: 'rewrote the trigger after it fired on the wrong requests',
      sha: 'a3f9c21d4b8e0a55c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c',
    },
    {
      ts: '1779000000',
      actor: 'distiller',
      rationale: '',
      sha: 'bb00112233445566778899aabbccddeeff00112233445566778899aabbccddee',
    },
  ],
};

vi.mock('@/api/api-client/skills-versions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/api-client/skills-versions')>();
  return {
    ...actual,
    listSkillVersions: vi.fn(() => Promise.resolve(versionsPayload)),
    getSkillVersionDiff: vi.fn(() => Promise.resolve({ diff: '' })),
  };
});

import { SkillVersionsPanel } from '../SkillVersionsPanel';
import {
  listSkillVersions,
  getSkillVersionDiff,
  type SkillVersionList,
} from '@/api/api-client/skills-versions';

const listMock = vi.mocked(listSkillVersions);
const diffMock = vi.mocked(getSkillVersionDiff);

function renderPanel(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(versionsPayload);
  diffMock.mockResolvedValue({ diff: '' });
});

describe('SkillVersionsPanel — the list', () => {
  it('lists every snapshot with its writer, reason and content fingerprint', async () => {
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const list = await screen.findByTestId('skill-version-list');
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    expect(list.textContent).toContain('user');
    expect(list.textContent).toContain('rewrote the trigger after it fired on the wrong requests');
    // Full sha in the row's tooltip, 7-char fingerprint on the row itself.
    expect(within(list).getByText('a3f9c21')).toBeInTheDocument();
    expect(within(list).getByText('bb00112')).toBeInTheDocument();
    expect(
      within(list).getByTitle(/^SHA-256 of this snapshot: bb001122/),
    ).toBeInTheDocument();
  });

  it('requests the versions of the NAMED skill, in the named scope', async () => {
    renderPanel(<SkillVersionsPanel name="quartus-flow" workspace={'C:\\Dev\\august-proxy'} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('quartus-flow', 'C:\\Dev\\august-proxy'));
  });

  it('says an untouched skill has no history — without claiming it loaded', async () => {
    listMock.mockResolvedValue({ versions: [] });
    renderPanel(<SkillVersionsPanel name="brand-new" />);
    expect(await screen.findByText(/No earlier version is retained/)).toBeInTheDocument();
    expect(screen.queryByTestId('query-error-state')).toBeNull();
  });

  it('shows the failure with Retry instead of an empty history', async () => {
    listMock.mockRejectedValue(new Error('versions: 500 boom'));
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load version history");
    expect(screen.queryByText(/No earlier version is retained/)).toBeNull();
  });
});

describe('SkillVersionsPanel — the diff', () => {
  it('does not request a diff until a version is selected', async () => {
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    await screen.findByTestId('skill-version-list');
    expect(diffMock).not.toHaveBeenCalled();
  });

  it('diffs the selected version and renders the unified diff', async () => {
    diffMock.mockResolvedValue({
      diff: '--- quartus-flow@1779000000\n+++ quartus-flow (current)\n@@ -1 +1 @@\n-old\n+new\n',
    });
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const list = await screen.findByTestId('skill-version-list');
    fireEvent.click(within(list).getByTestId('skill-version-1780000000'));

    await waitFor(() =>
      expect(diffMock).toHaveBeenCalledWith('quartus-flow', '1780000000', undefined),
    );
    const pane = await screen.findByTestId('skill-version-diff');
    expect(pane.textContent).toContain('against the current');
    // DiffView renders the parsed unified diff in its own region.
    const region = within(pane).getByRole('region', { name: /Diff: \+1 -1/ });
    expect(region.textContent).toContain('old');
    expect(region.textContent).toContain('new');
    expect(screen.queryByTestId('skill-version-identical')).toBeNull();
  });

  it('an EMPTY diff means this snapshot is what is live now', async () => {
    diffMock.mockResolvedValue({ diff: '' });
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const list = await screen.findByTestId('skill-version-list');
    fireEvent.click(within(list).getByTestId('skill-version-1780000000'));
    expect(await screen.findByTestId('skill-version-identical')).toBeInTheDocument();
  });

  it('a failed diff is a failure, not "no differences"', async () => {
    diffMock.mockRejectedValue(new Error('diff: 404 not found'));
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const list = await screen.findByTestId('skill-version-list');
    fireEvent.click(within(list).getByTestId('skill-version-1780000000'));
    const alert = await screen.findByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load this diff");
    expect(screen.queryByTestId('skill-version-identical')).toBeNull();
  });

  it('collapses the diff when the same version is clicked again', async () => {
    renderPanel(<SkillVersionsPanel name="quartus-flow" />);
    const list = await screen.findByTestId('skill-version-list');
    const row = within(list).getByTestId('skill-version-1780000000');
    fireEvent.click(row);
    await screen.findByTestId('skill-version-diff');
    fireEvent.click(within(list).getByTestId('skill-version-1780000000'));
    await waitFor(() => expect(screen.queryByTestId('skill-version-diff')).toBeNull());
  });
});
