import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SECTION_NAV_ITEMS } from '@/routes';

/* The review-inbox count used to ride the sidebar's Learning row; it now
 * rides the command palette's Tools item. The api module stays mocked so
 * the rendering tests never touch the network. */
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

  it('is chat-first: tool destinations live in the palette, not the sidebar', () => {
    // Reference contract, verified in the Stage 1 research:
    //   Hermes  — four durable pages in chrome (Chat/Skills/Messaging/
    //             Artifacts); Settings, Command Center, Profiles and the
    //             rest are overlay cards reachable from ⌘K.
    //   DeepSeek— brand + New Session + workspaces seat + a BOTTOM-pinned
    //             Settings seat; sections arrive as panel-list entries.
    //   Claude  — New Chat + history + an account footer.
    //   ChatGPT — many rows, but consumer content (Library/Sora/GPTs).
    // August's six rows duplicated the ⌘K palette's Tools group 1:1 (same
    // SECTION_NAV_ITEMS source), so the sidebar keeps conversation chrome:
    // New chat + Artifacts (also in the composer and titlebar).
    renderNav();
    expect(SECTION_NAV_ITEMS.filter((i) => i.to !== '/').length).toBeGreaterThanOrEqual(5);
    for (const item of SECTION_NAV_ITEMS) {
      if (item.to === '/') continue;
      expect(
        screen.queryByTestId(`sidebar-nav-${item.to.replace(/^\//, '')}`),
        `${item.to} should not be a sidebar row`,
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: item.label }),
        `${item.label} should not be a sidebar row`,
      ).toBeNull();
    }
    // What stays is chat-adjacent.
    expect(screen.getByRole('button', { name: 'Artifacts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeTruthy();
    // And no Customize row here either — Settings is bottom-pinned in
    // SessionList's footer (DeepSeek's seat), below the session list.
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
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
    // There is no `/projects` route: the old "Projects" row pointed at
    // `/board`, whose page is titled "Board", so the label could never be
    // true. ChatGPT's Projects is consumer content; August's workspaces
    // live in the session folders.
    renderNav();
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });
});