/**
 * Real-browser measurement of the subagent roster at a dozen workers.
 *
 * Stage D of the UI parity plan asks whether the roster *stays legible* when
 * several subagents run at once. That is a layout question, and jsdom reports
 * every element as 0×0 — a unit test can prove the twelve tabs are in the DOM
 * (it does: `RightDrawerSubagentsSection.test.tsx`) but cannot tell whether the
 * twelfth is reachable, or whether the strip stretches the pane. So this drives
 * the real drawer section, at the drawer's real 420 px width, in Chromium.
 *
 * No agents are run and no backend is involved: the section's two routes are
 * intercepted with twelve synthetic workers.
 */
import { expect, test } from '@playwright/test';
import { dismissFirstRunOverlays } from './first-run';

const WORKERS = Array.from({ length: 12 }, (_, i) => ({
  taskId: `w-${i}`,
  agentId: 'general',
  goal: `Inspect module ${i}`,
  status: i < 9 ? 'running' : 'completed',
  elapsed: 60 + i,
}));

test.beforeEach(async ({ page }) => {
  // Anything else the backend is asked for is answered the way a real backend
  // answers an unknown route — 404, not a 200 with an empty body. That matters:
  // a 200 `{}` is a shape the proxy never produces (measured: an unknown task id
  // returns `{taskId, events: []}`), and feeding one here crashed the pane on
  // `for (const ev of events)`. A green run must not depend on a backend either.
  const isApi = (url: URL) => url.pathname.startsWith('/api/');
  await page.route(isApi, (route) =>
    route.fulfill({ status: 404, json: { error: 'Not found', path: route.request().url() } }),
  );
  await page.route(
    (url) => isApi(url) && /^\/api\/workbench\/sessions\/[^/]+\/agents$/.test(url.pathname),
    (route) => route.fulfill({ json: { agents: WORKERS, meta: {} } }),
  );
  await page.route(
    (url) => isApi(url) && url.pathname === '/api/subagents/runs',
    (route) => route.fulfill({ json: { runs: [] } }),
  );
  await page.route(
    (url) => isApi(url) && /\/transcript$/.test(url.pathname),
    (route) => route.fulfill({ json: { taskId: 'w-11', events: [] } }),
  );
  await page.goto('/_design?lab=subagents', { waitUntil: 'domcontentloaded' });
  await dismissFirstRunOverlays(page);
  await expect(page.getByTestId('lab-drawer-width')).toBeVisible();
  await expect(page.getByTestId('right-drawer-subagent-w-0')).toBeVisible();
});

test.describe('subagent roster at twelve workers', () => {
  // The suite runs these beside four other Chromium instances against one vite
  // dev server, and this page pulls in the whole drawer section on first load.
  // Measured: 4.8 s alone, 30 s+ contended — so the timeout is set for the
  // contended case rather than retried into greenness.
  test('every worker gets a tab and the last one is reachable by scrolling', async ({ page }) => {
    test.setTimeout(90_000);
    const tablist = page.locator('[role="tablist"][aria-label="Subagent workers"]');
    await expect(tablist.locator('[role="tab"]')).toHaveCount(12);

    const pane = page.getByTestId('lab-drawer-width');
    const box = await pane.boundingBox();
    // The strip must scroll inside the pane, not widen it: the pane is still
    // exactly the drawer's own width with a dozen tabs in it.
    expect(Math.round(box!.width)).toBe(420);

    const geometry = await tablist.evaluate((el) => ({
      scrollable: el.scrollWidth > el.clientWidth,
      overflows: el.scrollWidth - el.clientWidth,
      widestTab: Math.max(
        ...Array.from(el.querySelectorAll('[role="tab"]')).map((t) => t.getBoundingClientRect().width),
      ),
    }));
    expect(geometry.widestTab, 'a tab must not swallow the strip').toBeLessThanOrEqual(192);
    expect(geometry.scrollable, 'twelve tabs in 420px must scroll horizontally').toBe(true);

    // Reach the twelfth by scrolling the strip itself (no wheel event needed —
    // a dragged scrollbar is the gesture a user actually has here).
    await tablist.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(tablist.evaluate((el) => el.scrollLeft)).resolves.toBeGreaterThan(0);
    const last = tablist.locator('[role="tab"]').nth(11);
    const reach = await Promise.all([
      last.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const strip = el.closest('[role="tablist"]')!.getBoundingClientRect();
        return { fullyInside: r.left >= strip.left - 1 && r.right <= strip.right + 1, text: el.textContent };
      }),
    ]);
    expect(reach[0].fullyInside, 'the last tab must land inside the strip when scrolled to').toBe(true);
    expect(reach[0].text).toContain('Inspect module 11');

    // And selecting it works — the roster is not merely present, it is usable.
    await last.click();
    await expect(page.getByTestId('right-drawer-subagent-view-w-11')).toBeVisible();
  });

  test('the × on a tab removes the view, and only the view', async ({ page }) => {
    test.setTimeout(90_000);
    const tablist = page.locator('[role="tablist"][aria-label="Subagent workers"]');
    const dismiss = tablist.locator('[aria-label*="Inspect module 3"]').first();
    await expect(dismiss).toHaveCount(1);
    await dismiss.click();
    // Not a no-op: the tab leaves the strip…
    await expect(tablist.locator('[role="tab"]')).toHaveCount(11);
    expect(
      await tablist.locator('[role="tab"]').evaluateAll((ts) => ts.map((t) => t.textContent).join('|')),
    ).not.toContain('Inspect module 3');
    // …while the worker keeps running: it is absent from the strip, not from
    // the session, and the other eleven are untouched.
    await expect(
      tablist.getByRole('tab', { name: 'Inspect module 4', exact: true }),
    ).toBeVisible();
  });
});
