import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* The Learning dock button reads the review-inbox count, so the nav now
 * needs the query client and the count endpoint. Mocked (not left to a real
 * fetch) so the badge assertions are deterministic. */
vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/api/client';
import { SessionListNav } from '../SessionListNav';
import { useRightDrawerStore } from '@/components/shell/RightDrawerState';

const getMock = vi.mocked(api.get);

type NavProps = Parameters<typeof SessionListNav>[0];

function renderNav(overrides: Partial<NavProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ harness: 0, memory: 0, total: 0 });
});

describe('SessionListNav', () => {
  it('constrains long workspace names without shrinking the collapse control', () => {
    const name = 'workspace-with-a-very-long-unbroken-folder-name';
    renderNav({ workspaceName: name });
    const label = screen.getByTitle(name);
    expect(label.classList.contains('truncate')).toBe(true);
    expect(label.parentElement?.classList.contains('min-w-0')).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide sidebar' }).classList.contains('shrink-0')).toBe(true);
  });
  it('every nav-flagged route has a dock button, so none can be orphaned', async () => {
    // The dock used to restate four routes by hand while routes.ts declared
    // six — /live carried `nav: true` and had no button anywhere. The list is
    // derived now, so a new nav route appears without touching this file.
    const { SECTION_NAV_ITEMS } = await import('@/routes');
    renderNav();
    const expected = SECTION_NAV_ITEMS.filter((item) => item.to !== '/');
    expect(expected.length).toBeGreaterThanOrEqual(5);
    for (const item of expected) {
      const id = `sidebar-nav-${item.to.replace(/^\//, '')}`;
      expect(screen.getByTestId(id), `${item.to} has no dock button`).toBeTruthy();
      expect(screen.getByRole('button', { name: item.label })).toBeTruthy();
    }
  });

  it('clicking the Live destination navigates to /live', () => {
    const onNavigate = vi.fn();
    renderNav({ onNavigate });
    fireEvent.click(screen.getByTestId('sidebar-nav-live'));
    expect(onNavigate).toHaveBeenCalledWith('/live');
  });

  it('renders the real top-level destinations and marks the active route', () => {
    const onNavigate = vi.fn();
    renderNav({ activePath: '/runs', onNavigate });

    const destinations = [
      ['sidebar-nav-automations', '/automations'],
      ['sidebar-nav-runs', '/runs'],
      ['sidebar-nav-board', '/board'],
      ['sidebar-nav-history', '/history'],
    ] as const;

    for (const [testId, path] of destinations) {
      fireEvent.click(screen.getByTestId(testId));
      expect(onNavigate).toHaveBeenCalledWith(path);
    }
    expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Automations', 'Board', 'History']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-current');
    }
    expect(screen.queryByTestId('sidebar-nav-skills')).toBeNull();
  });
  it('does not match sibling paths when marking the active route', () => {
    renderNav({ activePath: '/history-extra' });
    expect(screen.getByRole('button', { name: 'History' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('the Artifacts row opens the artifacts section instead of a no-op event', () => {
    // Regression: it dispatched `august:open-right-sidebar`, which only
    // reveals a panel the drawer store already has open — ChatLayout's sync
    // effect reverted it, so the button did nothing at all.
    useRightDrawerStore.setState({ open: false, sections: [] });
    renderNav();

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    const state = useRightDrawerStore.getState();
    expect(state.open).toBe(true);
    expect(state.sections).toContain('artifacts');
    expect(state.activeSection).toBe('artifacts');
  });

  it('has no row for a destination that does not exist', () => {
    // There is no `/projects` route: the "Projects" row pointed at `/board`,
    // whose page is titled "Board" and which the dock below already links, so
    // the label could never be true.
    renderNav();
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  it('badges the Learning dock button with the pending-decision count', async () => {
    // The count used to live only behind the Settings modal, so a proposal
    // waiting for approval was invisible from the main rail.
    getMock.mockResolvedValue({ harness: 1, memory: 2, total: 3 });
    renderNav();

    await waitFor(() =>
      expect(screen.getByTestId('sidebar-nav-badge-learning').textContent).toBe('3'),
    );
    // The badge rides the existing button — it must not become a second
    // control, and the accessible name stays the destination label.
    const dockButton = screen.getByTestId('sidebar-nav-learning');
    expect(dockButton.textContent).toContain('3');
    expect(dockButton).toHaveAttribute('aria-label', 'Learning');
    expect(dockButton).toHaveAttribute('title', 'Learning — 3 awaiting review');
  });

  it('shows no badge when nothing is waiting for a decision', async () => {
    renderNav();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByTestId('sidebar-nav-badge-learning')).toBeNull();
    expect(screen.getByTestId('sidebar-nav-learning')).toHaveAttribute('title', 'Learning');
  });
});
