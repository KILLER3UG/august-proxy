import { type Page } from '@playwright/test';

/**
 * Dismiss the first-run overlays before driving any lab.
 *
 * A fresh Playwright context has empty localStorage, so the app treats it as a
 * first run and mounts `OnboardingTour` (`[data-testid="onboarding-tour"]`,
 * `fixed inset-0 z-50` with a scrim) and/or the provider checklist. Both sit
 * above everything, so a lab button is visible and enabled yet
 * `pointer events` land on the overlay and the click retries until it times
 * out. That is what made the `/_design` labs look unclickable.
 *
 * Called from `beforeEach` because the tour can appear a second after load: a
 * click that succeeded before the overlay showed can fail after it.
 */
export async function dismissFirstRunOverlays(page: Page) {
  // Every step is best-effort with a short timeout: on a warm profile these
  // overlays do not exist at all, and a plain `.click()` on a hidden or absent
  // control would wait out the whole test timeout instead of moving on.
  const quiet = { timeout: 2_000 } as const;
  try {
    const skip = page.getByTestId('onboarding-tour').locator('button[aria-label="Skip onboarding"]');
    if (await skip.isVisible(quiet)) await skip.click(quiet);
  } catch {
    /* no tour */
  }
  try {
    const checklist = page.getByRole('button', { name: 'Skip for now' });
    if (await checklist.isVisible(quiet)) await checklist.click(quiet);
  } catch {
    /* no checklist */
  }
}
