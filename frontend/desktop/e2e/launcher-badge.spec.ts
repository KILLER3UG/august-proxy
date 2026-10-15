/**
 * Real-browser check of the workbench launcher's counters.
 *
 * The unit tests already pin how the numbers are *derived* (workers badge from
 * the roster, artifacts count from the transcript). What jsdom cannot show is
 * the render: the `9+` cap, the two indicators sitting on the same 44px button
 * without one covering the other, and the accessible name the screen reader
 * actually gets once the counts are in it. So the dev lab supplies the props and
 * Chromium reads the result.
 */
import { expect, test, type Page } from '@playwright/test';
import { dismissFirstRunOverlays } from './first-run';

test.describe('workbench launcher counters', () => {
  test.beforeEach(async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 404, json: { error: 'Not found' } }),
    );
    await page.goto('/_design?lab=launcher', { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(page);
    await expect(page.getByTestId('lab-launcher')).toBeVisible();
  });

  // Scoped to the lab on purpose: `/_design` renders inside the app shell, whose
  // titlebar carries a launcher of its own — an unscoped locator finds four.
  const labLaunchers = (p: Page) =>
    p.getByTestId('lab-launcher').locator('[data-testid="workbench-launcher"]');

  test('the badge shows the count, caps at 9+, and nothing shows at zero', async ({ page }) => {
    test.setTimeout(60_000);
    const launchers = labLaunchers(page);
    await expect(launchers).toHaveCount(3);

    // Case 1 — zero workers, zero artifacts: no badge, no dot.
    const quiet = launchers.nth(0);
    await expect(quiet.locator('span')).toHaveCount(0);
    await expect(quiet).toHaveAttribute('aria-label', 'Open Workbench');

    // Case 2 — 3 workers and 5 artifacts: the number, the dot, and the count
    // spoken in the accessible name.
    const busy = launchers.nth(1);
    await expect(busy.locator('[data-testid="workbench-artifacts-indicator"]')).toBeVisible();
    const badge = busy.locator('span').filter({ hasText: /^3$/ });
    await expect(badge).toHaveCount(1);
    await expect(busy).toHaveAttribute('aria-label', 'Open Workbench, 5 artifacts available');

    // Case 3 — twelve workers: the cap, not the number.
    const capped = launchers.nth(2);
    await expect(capped.locator('span').filter({ hasText: '9+' })).toHaveCount(1);
    await expect(capped.locator('span').filter({ hasText: /^12$/ })).toHaveCount(0);
  });

  test('the two indicators stay inside the button and clear each other', async ({ page }) => {
    test.setTimeout(60_000);
    const busy = labLaunchers(page).nth(1);
    const geometry = await busy.evaluate((btn) => {
      const box = btn.getBoundingClientRect();
      const parts = Array.from(btn.querySelectorAll('span')).map((s) => {
        const r = s.getBoundingClientRect();
        return {
          text: (s.textContent || '').trim(),
          inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5
            && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
          height: Math.round(r.height),
        };
      });
      const dot = btn.querySelector('[data-testid="workbench-artifacts-indicator"]')!.getBoundingClientRect();
      const badge = Array.from(btn.querySelectorAll('span'))
        .find((s) => /^\d/.test((s.textContent || '').trim()))!.getBoundingClientRect();
      return {
        parts,
        allInside: parts.every((p) => p.inside),
        overlap: !(dot.right < badge.left || dot.left > badge.right || dot.bottom < badge.top || dot.top > badge.bottom),
        badgeHeight: Math.round(badge.height),
      };
    });
    expect(geometry.allInside, 'both indicators must sit inside the 44px button').toBe(true);
    expect(geometry.overlap, 'the artifacts dot must not sit on top of the worker count').toBe(false);
    expect(geometry.badgeHeight, 'a count you cannot read is not a count').toBeGreaterThanOrEqual(12);
  });
});
