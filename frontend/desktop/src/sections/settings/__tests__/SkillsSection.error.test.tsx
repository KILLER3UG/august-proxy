/* ── SkillsSection: honest failure state ───────────────────────────────────
 * A failed /api/skills request rendered "No skills yet — click New to author
 * your first skill", which is a claim the app cannot make after a transport
 * error. The grid must show the failure (with Retry) instead.              */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/client', () => ({ api: { get: mocks.get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import { SkillsSection } from '../SkillsSection';

configure({ asyncUtilTimeout: 5000 });

const SKILL = {
  name: 'circuit-helper',
  description: 'Build and test circuits',
  trigger: '',
  category: 'development',
  enabled: true,
  createdBy: 'agent',
  scope: 'agent',
  overrides: '',
  usageCount: 0,
  lastUsed: '',
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SkillsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SkillsSection — list query failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith('/api/skills')) return Promise.reject(new Error('skills: 500 boom'));
      if (path.includes('memory/workspaces')) return Promise.resolve({ workspaces: [] });
      return Promise.resolve({});
    });
  });

  it('shows the failure with Retry instead of "No skills yet"', async () => {
    renderSection();
    const grid = await screen.findByTestId('skills-grid');
    await waitFor(() => expect(within(grid).getByTestId('query-error-state')).toBeTruthy());
    const alert = within(grid).getByTestId('query-error-state');
    expect(alert.textContent).toContain("Couldn't load skills");
    expect(alert.textContent).toContain('500 boom');
    expect(within(grid).queryByText('No skills yet')).toBeNull();
    // The header count must not claim a real, empty catalogue.
    expect(screen.queryByText(/^0 skills/)).toBeNull();
  });

  it('Retry re-requests and renders the catalogue', async () => {
    renderSection();
    const grid = await screen.findByTestId('skills-grid');
    await waitFor(() => expect(within(grid).getByTestId('query-error-state')).toBeTruthy());

    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith('/api/skills')) return Promise.resolve({ skills: [SKILL], total: 1 });
      if (path.includes('memory/workspaces')) return Promise.resolve({ workspaces: [] });
      return Promise.resolve({});
    });
    fireEvent.click(within(grid).getByTestId('query-error-retry'));

    await waitFor(() => expect(screen.getByTestId('skill-row-circuit-helper')).toBeTruthy());
    expect(within(grid).queryByTestId('query-error-state')).toBeNull();
  });
});
