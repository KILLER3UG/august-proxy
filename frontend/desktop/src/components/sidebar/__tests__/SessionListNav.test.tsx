import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SessionListNav } from '../SessionListNav';
import { useRightDrawerStore } from '@/components/shell/RightDrawerState';

describe('SessionListNav', () => {
  it('constrains long workspace names without shrinking the collapse control', () => {
    const name = 'workspace-with-a-very-long-unbroken-folder-name';
    render(
      <SessionListNav
        workspaceName={name}
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );
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
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );
    const expected = SECTION_NAV_ITEMS.filter((item) => item.to !== '/');
    expect(expected.length).toBeGreaterThanOrEqual(5);
    for (const item of expected) {
      const id = `sidebar-nav-${item.to.replace(/^\//, '')}`;
      expect(screen.getByTestId(id), `${item.to} has no dock button`).toBeTruthy();
      expect(screen.getByRole('button', { name: item.label })).toBeTruthy();
    }
  });

  it('clicking the Live destination navigates to /live', async () => {
    const onNavigate = vi.fn();
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('sidebar-nav-live'));
    expect(onNavigate).toHaveBeenCalledWith('/live');
  });

  it('renders the real top-level destinations and marks the active route', () => {
    const onNavigate = vi.fn();
    render(
      <SessionListNav
        activePath="/runs"
        onNew={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );

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
    render(
      <SessionListNav
        activePath="/history-extra"
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'History' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('the Artifacts row opens the artifacts section instead of a no-op event', () => {
    // Regression: it dispatched `august:open-right-sidebar`, which only
    // reveals a panel the drawer store already has open — ChatLayout's sync
    // effect reverted it, so the button did nothing at all.
    useRightDrawerStore.setState({ open: false, sections: [] });
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );

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
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });
});
