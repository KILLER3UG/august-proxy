/**
 * Accessibility smoke routes (audit A2 / P2 straggler): one axe scan per main
 * rail. The desktop normally runs inside Tauri against a live Python proxy;
 * in web (Vite) mode the API calls fail and the UI renders its offline
 * states — which is fine for a structure scan: axe judges the rendered DOM.
 *
 * Gate: CRITICAL violations fail the route. Serious-and-below print and are
 * tracked by eye — a zero-noise gate on a dense app goes red forever and
 * then gets ignored, which is worse than a narrow, honest gate.
 *
 * Run: npm run test:e2e (starts the Vite dev server itself, or reuses one).
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ROUTES = ['/', '/automations', '/settings'] as const;

test.describe.configure({ mode: 'serial' });

for (const route of ROUTES) {
  test(`axe: ${route} has no critical violations`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    // Let the router + shell settle; offline states are acceptable, crashes are not.
    await page.waitForTimeout(1_500);
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => (v.impact ?? '') === 'critical');
    if (critical.length > 0) {
      const summary = critical
        .map((v) => `${v.id} (${v.nodes.length} node(s)): ${v.nodes[0]?.target.join(' ')}`)
        .join('\n  ');
      throw new Error(`critical a11y violations on ${route}:\n  ${summary}`);
    }
    const serious = results.violations.filter((v) => (v.impact ?? '') === 'serious');
    if (serious.length > 0) {
      console.log(`[axe] ${route} serious (non-gating): ${serious.map((v) => v.id).join(', ')}`);
    }
    expect(results.violations).toBeDefined();
  });
}
