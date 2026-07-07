/* ── WorkspaceShell — tier filter (Show advanced toggle) regression ──── */
/* Verifies the v3 IA behaviour:
 *   • when showAdvanced = false, only basic-tier sections render in the rail
 *   • when showAdvanced = true, every section renders
 *   • the active section is always rendered even when advanced is hidden
 *     (deep-link case, e.g. /settings/brain)
 *   • search bypasses the tier filter so users can find advanced sections
 *     by keyword even when advanced is hidden
 *
 * Persistence comes from useSettingsAdvancedPreference; the tests pre-seed
 * localStorage in beforeEach to control the initial value. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Mock react-router-dom so WorkspaceShell can call useNavigate without a
// real router. We don't need to assert on navigation here — only on what
// renders in the rail.
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

import { WorkspaceShell, type WorkspaceSectionMeta } from '@/components/workspace/WorkspaceShell';
import { SETTINGS_SECTIONS } from '@/settings/settings-registry';

const ADV_KEY = 'august-settings-advanced';

// Pick a deterministic, mixed-cohort slice from the real registry so the
// test exercises the same id/label/icon/category/tier wiring production
// uses. Cover both tiers and both security + activity categories.
const BASIC_IDS = ['system-health', 'skills', 'api-access'];
const ADVANCED_IDS = ['brain-orchestrator', 'computer-access', 'developer-console'];

function pickSections(): WorkspaceSectionMeta[] {
  const ids = [...BASIC_IDS, ...ADVANCED_IDS];
  return SETTINGS_SECTIONS.filter((s) => ids.includes(s.id)).map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    category: s.category,
  }));
}

function visibleRailLabels() {
  // The rail uses <button> elements for each nav link; their accessible
  // name is the label text. We assert against labels (not ids) because
  // that's what the user sees.
  const nav = screen.getByRole('navigation');
  return within(nav)
    .getAllByRole('button')
    .map((b) => b.textContent?.trim() ?? '')
    .filter((t) => t.length > 0);
}

describe('WorkspaceShell — tier filter', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('with showAdvanced=false (default), only basic items render in the rail', () => {
    // localStorage empty → hook defaults to false.
    render(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );
    const labels = visibleRailLabels();
    for (const id of BASIC_IDS) {
      const sec = SETTINGS_SECTIONS.find((s) => s.id === id)!;
      expect(labels.some((l) => l.includes(sec.label)), `${sec.label} should render`).toBe(true);
    }
    for (const id of ADVANCED_IDS) {
      const sec = SETTINGS_SECTIONS.find((s) => s.id === id)!;
      expect(labels.some((l) => l.includes(sec.label)), `${sec.label} should be hidden`).toBe(false);
    }
  });

  it('with showAdvanced=true, every section renders in the rail', () => {
    localStorage.setItem(ADV_KEY, 'true');
    render(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );
    const labels = visibleRailLabels();
    for (const id of [...BASIC_IDS, ...ADVANCED_IDS]) {
      const sec = SETTINGS_SECTIONS.find((s) => s.id === id)!;
      expect(labels.some((l) => l.includes(sec.label)), `${sec.label} should render`).toBe(true);
    }
  });

  it('the active advanced section is always rendered even when advanced is hidden (deep-link case)', () => {
    // localStorage empty → showAdvanced=false. But active=brain-orchestrator
    // is advanced. Deep links like /settings/brain must still resolve so
    // the user lands somewhere sensible.
    localStorage.clear();
    render(
      <WorkspaceShell sections={pickSections()} active="brain-orchestrator">
        <div>main</div>
      </WorkspaceShell>,
    );
    const labels = visibleRailLabels();
    const brain = SETTINGS_SECTIONS.find((s) => s.id === 'brain-orchestrator')!;
    expect(labels.some((l) => l.includes(brain.label)), 'active advanced section must render').toBe(true);
    // Other advanced items still hidden.
    const dev = SETTINGS_SECTIONS.find((s) => s.id === 'developer-console')!;
    expect(labels.some((l) => l.includes(dev.label))).toBe(false);
  });

  it('search input matches advanced items by keyword even when advanced is hidden', () => {
    localStorage.clear();
    render(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );

    // Search bypasses tier filter — 'developer' is a keyword of
    // developer-console (advanced). It should appear even though
    // showAdvanced=false.
    const input = screen.getByLabelText(/Search settings/i);
    fireEvent.change(input, { target: { value: 'developer' } });

    const labels = visibleRailLabels();
    const dev = SETTINGS_SECTIONS.find((s) => s.id === 'developer-console')!;
    expect(labels.some((l) => l.includes(dev.label))).toBe(true);
  });

  it('search by label also matches advanced items when advanced is hidden', () => {
    localStorage.clear();
    render(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );

    const input = screen.getByLabelText(/Search settings/i);
    // "Computer Access" — search by partial label.
    fireEvent.change(input, { target: { value: 'computer' } });

    const labels = visibleRailLabels();
    const ca = SETTINGS_SECTIONS.find((s) => s.id === 'computer-access')!;
    expect(labels.some((l) => l.includes(ca.label))).toBe(true);
  });

  it('the "Show advanced" toggle flips the toggle button label', () => {
    localStorage.clear();
    render(
      <WorkspaceShell sections={pickSections()} active="system-health">
        <div>main</div>
      </WorkspaceShell>,
    );

    const btn = screen.getByRole('button', { name: /show advanced/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(btn);

    const hide = screen.getByRole('button', { name: /hide advanced/i });
    expect(hide.getAttribute('aria-pressed')).toBe('true');
    // And now an advanced section shows up.
    const labels = visibleRailLabels();
    const brain = SETTINGS_SECTIONS.find((s) => s.id === 'brain-orchestrator')!;
    expect(labels.some((l) => l.includes(brain.label))).toBe(true);
  });
});