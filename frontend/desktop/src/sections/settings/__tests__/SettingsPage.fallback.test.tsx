import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const invalidateQueries = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock('@/hooks/useProviderOnboardingState', () => ({
  useProviderOnboardingState: () => ({
    dismissed: true,
    isLoading: false,
    allCoreDone: true,
  }),
}));
vi.mock('@/components/workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({
    active,
    sections,
    children,
  }: {
    active: string;
    sections: Array<{ id: string }>;
    children: React.ReactNode;
  }) => (
    <div data-testid="settings-page-shell" data-active={active}>
      {sections.map((section) => (
        <span key={section.id} data-testid={`settings-section-${section.id}`} />
      ))}
      {children}
    </div>
  ),
}));

import { SettingsPage } from '../SettingsPage';

function renderPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SettingsPage — unimplemented route fallback', () => {
  it('falls back for the REMOVED hooks deep link (section deleted 2026-10-03)', async () => {
    renderPage('/settings/hooks');

    await waitFor(() => {
      expect(screen.getByTestId('settings-page-shell')).toHaveAttribute(
        'data-active',
        'general',
      );
    });
    expect(screen.queryByTestId('settings-section-hooks')).toBeNull();
  });

  it('falls back for the REMOVED indexing deep link (section deleted 2026-10-03)', async () => {
    renderPage('/settings/indexing');

    await waitFor(() => {
      expect(screen.getByTestId('settings-page-shell')).toHaveAttribute(
        'data-active',
        'general',
      );
    });
    expect(screen.queryByTestId('settings-section-indexing')).toBeNull();
  });
});
