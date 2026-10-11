import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* The review-inbox count used to ride the sidebar's Learning row; it now
 * rides the command palette's Tools item. The api module stays mocked so
 * the rendering tests never touch the network. */
vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/api/client';
import { SessionListNav } from '../SessionListNav';

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

  it('surfaces the primary destinations and workspace switcher without duplicating Artifacts', () => {
    renderNav();
    expect(screen.getByRole('button', { name: 'Automations' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Board' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Learning' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /New chat/ })).toBeTruthy();
    expect(screen.getByTestId('workspace-switcher')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Artifacts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
  });

  it('navigates to a primary destination', () => {
    const onNavigate = vi.fn();
    renderNav({ onNavigate });

    fireEvent.click(screen.getByRole('button', { name: 'Board' }));

    expect(onNavigate).toHaveBeenCalledWith('/board');
  });

  it('keeps the full routes outside the visible primary rows', () => {
    renderNav();
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });
});
