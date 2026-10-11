/* ── AppearanceSection test ────────────────────────────────────────────
 * Guards the responsive contract of the two controls that used to overflow
 * the settings panel as it narrowed, and the pill shape the reference uses.
 *
 * The failures here were measured in a live browser, not predicted: at a
 * 420px panel the "Light" and "Dark" buttons of the Mode control rendered
 * outside the content column, and at 340px all four font-size pills did too,
 * because both sat in `justify-between` rows next to a `shrink-0` control
 * that could never shrink and so could never wrap.
 *
 * jsdom has no layout engine, so what is asserted here is the class contract
 * that produces the measured result — no `shrink-0` on a control that has to
 * survive a narrow column, and `flex-wrap` on the rows and the group. The
 * numbers themselves live in the redesign spec. */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppearanceSection } from '../AppearanceSection';

function renderAppearance() {
  return render(<AppearanceSection active={undefined} />);
}

describe('AppearanceSection — responsive contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('wraps the Mode row instead of overflowing a narrow column', () => {
    renderAppearance();
    const group = screen.getByRole('group', { name: 'Theme mode' });
    const row = group.parentElement as HTMLElement;

    // The row must be allowed to wrap the control onto its own line.
    expect(row.className).toContain('flex-wrap');
    // …and the control must be allowed to shrink, or the wrap never engages.
    // `shrink-0` here is what pushed Light/Dark outside the column at 420px.
    expect(group.className).toContain('flex-wrap');
    expect(group.className).not.toMatch(/\bshrink-0\b/);
  });

  it('wraps the font-size rows so the pill cannot be pushed out', () => {
    renderAppearance();
    const pills = ['Interface font size', 'Chat messages font size', 'Chat input font size', 'Code font size'];
    for (const label of pills) {
      const pill = screen.getByLabelText(label);
      const row = pill.closest('div.flex') as HTMLElement;
      expect(row, `no flex row found for ${label}`).toBeTruthy();
      expect(row.className, `${label} row must wrap`).toContain('flex-wrap');
    }
  });

  it('gives every font-size control a pill, not a native select', () => {
    // The reference draws `Interface  [13 px]` — one pill showing the current
    // value. This was four native <select>s, which rendered the platform's own
    // dropdown affordance and ignored the theme, on the page that is meant to
    // be four quiet rows. Measured on the live render: 4 native selects -> 0.
    const { container } = renderAppearance();
    expect(container.querySelectorAll('select')).toHaveLength(0);
    for (const label of ['Interface font size', 'Chat messages font size', 'Chat input font size', 'Code font size']) {
      expect(screen.getByLabelText(label).tagName).toBe('BUTTON');
    }
  });

  it('keeps the theme swatches on a responsive grid', () => {
    renderAppearance();
    const swatch = screen.getByTestId('appearance-theme-haze');
    const grid = swatch.parentElement as HTMLElement;
    // Two columns when narrow, five when there is room — not a fixed 5, which
    // is what made the swatch row the widest fixed element on the page.
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).toContain('sm:grid-cols-5');
  });
});