/* ── WorkspaceShell — header IA (no advanced toggle) ──────────────── */
/* Since the 2026-08-28 restructure the rail shows 3 header groups
 * (Settings / Agent Capabilities / Data & Statistics), not section rows.
 * Search surfaces matching sections grouped by category. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/settings/system-health' }),
}));

vi.mock('@/hooks/useAppUpdate', () => ({
  useAppUpdate: () => ({ available: false, installing: false, progress: null }),
}));

import { WorkspaceShell, type WorkspaceSectionMeta } from '@/components/workspace/WorkspaceShell';
import { SETTINGS_SECTIONS, SETTINGS_CATEGORIES } from '@/settings/settings-registry';

function renderShell(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function pickSections(): WorkspaceSectionMeta[] {
  const ids = ['system-health', 'skills', 'api-access', 'computer-access', 'observability', 'computer-use'];
  return SETTINGS_SECTIONS.filter((s) => ids.includes(s.id)).map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    category: s.category,
  }));
}

function visibleRailLabels() {
  const nav = screen.getByRole('navigation');
  return within(nav)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter((t) => t.length > 0);
}

describe('WorkspaceShell — hub IA', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows category headings and sections in the rail when not searching', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    for (const cat of SETTINGS_CATEGORIES) {
      expect(screen.getByText(cat.label)).toBeInTheDocument();
    }
    const labels = visibleRailLabels();
    expect(labels).toContain('General');
    expect(labels).toContain('Skills');
  });

  it('search surfaces matching sections grouped by category', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );
    const input = screen.getByLabelText(/Search settings/i);
    fireEvent.change(input, { target: { value: 'audit' } });
    const labels = visibleRailLabels();
    const obs = SETTINGS_SECTIONS.find((s) => s.id === 'observability')!;
    expect(labels.some((l) => l.includes(obs.label))).toBe(true);
  });

  it('search with no match shows empty state', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );
    const input = screen.getByLabelText(/Search settings/i);
    fireEvent.change(input, { target: { value: 'zzzznope' } });
    expect(screen.getByText(/No sections match/)).toBeInTheDocument();
  });
});
