/**
 * Real-browser checks of the transcript's hidden-but-focusable controls.
 *
 * Two shapes of the same defect, both measured in Chromium because jsdom
 * renders a class and stops there — it never computes opacity, and never
 * refuses a focus.
 *
 * 1. The working strip. It is the live activity line above the composer: a
 *    phase pill, the sentence stack, and — once the model has posted a plan —
 *    a button that expands the checklist. With no turn streaming it collapses
 *    to `height:0`, fades to `opacity:0` and is `aria-hidden`. `aria-hidden`
 *    does not withdraw a control from the tab order, so the app kept an
 *    invisible, focusable button above the composer: Tab landed on it, Enter
 *    expanded a checklist nobody could see. `inert` is what removes it.
 * 2. The per-message action rows. Hidden the same way (opacity only), and they
 *    carry seven buttons per exchange. The assistant row asked for
 *    `group-focus-within:` while no ancestor carries `group`, so the reveal
 *    never fired; the user row asked for nothing. Both now reveal on their own
 *    `:focus-within`, which is what the transition has to settle before the
 *    computed value moves — the reading is taken after it does.
 */
import { expect, test, type Page } from '@playwright/test';
import { dismissFirstRunOverlays } from './first-run';

const strip = (page: Page, state: 'collapsed' | 'live') =>
  page
    .getByTestId(`lab-strip-${state}`)
    .locator('[data-testid="aug-working-indicator"]');

async function opacityOnFocus(page: Page, ariaLabel: string) {
  const btn = page.getByTestId('lab-working-strip').locator(`button[aria-label="${ariaLabel}"]`).first();
  const row = btn.locator('xpath=..');
  const before = await row.evaluate((el) => getComputedStyle(el).opacity);
  await btn.focus();
  await page.waitForTimeout(300);
  const focused = await row.evaluate((el) => getComputedStyle(el).opacity);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  const blurred = await row.evaluate((el) => getComputedStyle(el).opacity);
  return { before, focused, blurred };
}

test.describe('the transcript’s hidden controls', () => {
  test.beforeEach(async ({ page }) => {
    // 404, not a mock 200: an unknown route must look absent, or the client
    // iterates a payload shape the backend would never send.
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 404, json: { error: 'Not found' } }),
    );
    await page.goto('/_design?lab=working', { waitUntil: 'domcontentloaded' });
    await dismissFirstRunOverlays(page);
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

  test('the assistant action row reveals itself when focus reaches it', async ({ page }) => {
    test.setTimeout(60_000);
    const read = await opacityOnFocus(page, 'Copy');
    expect(read).toEqual({ before: '0', focused: '1', blurred: '0' });
  });

  test('the user action row does the same', async ({ page }) => {
    test.setTimeout(60_000);
    const read = await opacityOnFocus(page, 'Copy message');
    expect(read).toEqual({ before: '0', focused: '1', blurred: '0' });
  });
});
