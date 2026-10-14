/**
 * Real-browser check of the working strip above the composer.
 *
 * The strip is the live activity line: a phase pill, the sentence stack, and —
 * once the model has posted a plan — a `<button>` (`working-todos-toggle`) that
 * expands the checklist. When no turn is streaming the strip collapses to
 * `height:0`, fades to `opacity:0` and is `aria-hidden`. `aria-hidden` does not
 * remove a control from the tab order, so the app kept an invisible, focusable
 * button above the composer: Tab landed on it, Enter expanded a checklist that
 * could not be seen. `inert` is what actually withdraws the subtree, and jsdom
 * only reflects the attribute — it never refuses the focus. So both states of
 * the real pane are mounted in the dev lab and Chromium reads the difference.
 */
import { expect, test, type Page } from '@playwright/test';

const strip = (page: Page, state: 'collapsed' | 'live') =>
  page
    .getByTestId(`lab-strip-${state}`)
    .locator('[data-testid="aug-working-indicator"]');

test.describe('the working strip above the composer', () => {
  test.beforeEach(async ({ page }) => {
    // 404, not a mock 200: an unknown route must look absent, or the client
    // iterates a payload shape the backend would never send.
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 404, json: { error: 'Not found' } }),
    );
    await page.goto('/_design?lab=working', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('lab-working-strip')).toBeVisible();
    await expect(strip(page, 'collapsed')).toHaveCount(1);
    await expect(strip(page, 'live')).toHaveCount(1);
  });

  test('the collapsed strip hides its own plan toggle and refuses it focus', async ({ page }) => {
    test.setTimeout(60_000);
    const read = await strip(page, 'collapsed').evaluate((el) => {
      const wrap = el.parentElement!;
      const box = wrap.getBoundingClientRect();
      const toggle = wrap.querySelector<HTMLButtonElement>('[data-testid="working-todos-toggle"]');
      toggle?.focus();
      return {
        inert: wrap.hasAttribute('inert'),
        ariaHidden: wrap.getAttribute('aria-hidden'),
        height: Math.round(box.height),
        opacity: getComputedStyle(wrap).opacity,
        togglePresent: !!toggle,
        toggleFocused: document.activeElement === toggle,
      };
    });
    expect(read).toEqual({
      inert: true,
      ariaHidden: 'true',
      height: 0,
      opacity: '0',
      togglePresent: true,
      toggleFocused: false,
    });
  });

  test('while streaming, the same toggle is visible and takes focus', async ({ page }) => {
    test.setTimeout(60_000);
    const read = await strip(page, 'live').evaluate((el) => {
      const wrap = el.parentElement!;
      const toggle = wrap.querySelector<HTMLButtonElement>('[data-testid="working-todos-toggle"]');
      toggle?.focus();
      return {
        inert: wrap.hasAttribute('inert'),
        height: Math.round(wrap.getBoundingClientRect().height),
        toggleFocused: document.activeElement === toggle,
      };
    });
    expect(read.inert).toBe(false);
    expect(read.height).toBeGreaterThan(0);
    expect(read.toggleFocused).toBe(true);
  });

  test('the toggle still expands the checklist once focus reaches it', async ({ page }) => {
    test.setTimeout(60_000);
    const todos = page
      .getByTestId('lab-strip-live')
      .getByTestId('working-todos-toggle');
    await expect(page.getByTestId('lab-strip-live').getByTestId('working-todo-row')).toHaveCount(0);
    await todos.click();
    await expect(page.getByTestId('lab-strip-live').getByTestId('working-todo-row')).toHaveCount(3);
    await expect(todos).toHaveAttribute('aria-expanded', 'true');
  });
});
