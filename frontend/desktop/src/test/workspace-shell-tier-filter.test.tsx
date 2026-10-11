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
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';

function renderShell(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function pickSections(): WorkspaceSectionMeta[] {
  const ids = ['system-health', 'skills', 'api-access', 'computer-access', 'observability', 'computer-use', 'hooks', 'indexing'];
  const implementedIds = new Set(ids.filter((id) => !['hooks', 'indexing'].includes(id)));
  return SETTINGS_SECTIONS.filter((s) => implementedIds.has(s.id)).map((s) => ({
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

  it('gives the reading column the full width left by the rail', () => {
    // This assertion used to require `pr-60` — a right-side pad mirroring the
    // 240px rail, added to centre the column on the WINDOW rather than in the
    // space the rail leaves. Measured, that pad was the defect: it left 361px
    // of usable column inside an 848px panel, against ~640px in the reference,
    // and the centring it bought is not a reference behaviour at all. Haze's
    // content pane sits 91px RIGHT of window centre because its rail is inside
    // the modal — the same geometry this now produces without the pad.
    //
    // jsdom has no layout engine, so the geometry itself cannot be asserted
    // here. What is assertable is the class contract that produces it: no
    // rail-width pad on the region, a rail-sized max on the column, and the
    // two kept in step by the same `60` so a future rail change cannot drift
    // one without the other.
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const region = screen.getByTestId('settings-content-region');
    const cls = region.className;
    expect(cls).toContain('justify-center');
    expect(cls).not.toMatch(/\bpr-\d+\b/);
    expect(screen.getByTestId('settings-content-column').className).toContain('max-w-[680px]');
  });

  it('floats the panel over the app instead of tinting the background', () => {
    // The reference settings modal leaves the sidebar, transcript and composer
    // at full brightness. `bg-scrim` is rgb(0 0 0 / 0.55) in dark mode, which
    // visibly darkened all three, so the backdrop is untinted and the dialog's
    // own border plus shadow carry the separation. `aria-modal` and the focus
    // trap are what actually enforce modality, and neither is visual.
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const backdrop = screen.getByTestId('settings-backdrop');
    expect(backdrop.className).not.toContain('bg-scrim');
    // Still a fixed, full-viewport hit target, so click-outside keeps working
    // and Escape still has something to land on.
    expect(backdrop.className).toContain('fixed');
    expect(backdrop.className).toContain('inset-0');
  });

  it('caps the panel height so it does not fill the window', () => {
    // `h-full max-h-full` inside a `fixed inset-0` flex box pinned the panel to
    // the full viewport height minus padding — 92% of the window, at any window
    // size, so opening settings covered essentially the whole app. 680px is the
    // reference panel's measured height (680 in a 1200px window), and `min()`
    // keeps the cap honest on a short window, which scrolls instead of
    // overflowing.
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).not.toMatch(/\bh-full\b/);
    expect(dialog.className).toMatch(/max-h-\[min\(680px,calc\(100vh-4rem\)\)\]/);
  });

  it('lets the rail shrink to the panel so its footer is never clipped', () => {
    // The rail carried `h-full`, which against a content-driven, max-h-capped
    // parent resolves to the rail's own content height — measured 670px inside
    // a 636px panel, with the profile footer cut off by `overflow-hidden`.
    // `align-items: stretch` plus `min-h-0` sizes it to the panel instead.
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const rail = screen.getByLabelText('Settings sections');
    expect(rail.className).not.toMatch(/\bh-full\b/);
    expect(rail.className).toContain('min-h-0');
  });

  it('yields rail width on a narrow panel so content is not squeezed out', () => {
    // At a fixed `w-60` the rail never yielded. Forcing the panel narrow
    // measured: 560px -> 313px column with the Mode control's "Dark" button
    // outside it; 420px -> 173px column with System/Light/Dark and all four
    // font pills overflowing; 340px -> 93px column plus a horizontal
    // scrollbar. Below `sm` the rail drops to w-44, which holds those cases.
    // Both widths must stay declared together — dropping the narrow one
    // silently reinstates the squeeze, and no browser check runs in CI.
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const rail = screen.getByLabelText('Settings sections');
    expect(rail.className).toContain('w-44');
    expect(rail.className).toContain('sm:w-60');
  });

  it('shows category headings and sections in the rail when not searching', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const labels = visibleRailLabels();
    expect(labels).toContain('Skills');
    expect(labels).not.toContain('General');
    expect(labels).not.toContain('Hooks');
    expect(labels).not.toContain('Indexing');
  });

  it('constrains the rail and keeps rail metadata readable', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const rail = document.querySelector('aside');
    expect(rail?.className).toContain('overflow-hidden');
    const input = screen.getByLabelText(/Search settings/i);
    fireEvent.change(input, { target: { value: 'hooks' } });
    // The counter names BOTH numbers. Search reaches every registered section —
    // the hidden ones included, which is what makes them reachable at all — so
    // a bare "0 of 6" next to a 2-row rail read as a contradiction instead of a
    // fact. The fixture is the discrepancy in miniature: 6 passed in, 2 drawn.
    const counter = screen.getByTestId('settings-search-count');
    expect(counter.textContent).toBe('0 of 6 sections · 2 in the rail');
    expect(counter.className).toContain('text-xs');
    // Filtering a rail is otherwise silent.
    expect(counter.getAttribute('role')).toBe('status');
  });

  it('does not surface unimplemented sections from the passed registry', () => {
    renderShell(
      <WorkspaceShell sections={pickSections()} active="skills">
        <div>main</div>
      </WorkspaceShell>,
    );
    const input = screen.getByLabelText(/Search settings/i);
    fireEvent.change(input, { target: { value: 'hooks' } });
    expect(screen.getByText(/No sections match/)).toBeInTheDocument();
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
