/**
 * Real-browser check for the transcript scroll pin.
 *
 * Why this exists as an e2e rather than a unit test: the pin is released by a
 * `scroll` event, and a jsdom `dispatchEvent` proves only that the handler is
 * wired — not that a browser delivers the event to it at all. Measured directly:
 * inside the in-app automation browser, assigning `scrollTop` on the transcript
 * moved the value (4602 → 4202) while a capture-phase `scroll` listener attached
 * to `document` observed **zero** events. Every "live" reading of this behaviour
 * taken through that browser was therefore unreadable in both directions.
 *
 * Playwright drives a real Chromium with a real viewport, so the event is
 * genuine. The harness is the dev-only `/_design` lab, which mounts the real
 * hook and needs no backend.
 */
import { expect, test } from '@playwright/test';

test.describe('transcript scroll pin', () => {
  test('a scroll with no wheel event releases the pin', async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto('/_design', { waitUntil: 'domcontentloaded' });

    const scroller = page.getByTestId('lab-scroller');
    await expect(scroller).toBeVisible();
    await page.waitForTimeout(500);

    // Start pinned, at the bottom.
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await expect(scroller).not.toHaveClass(/chat-scroll--free/);

    // The case the report was about: the view moves up with no wheel, touch or
    // key event — a scrollbar drag, a focus jump, `scrollIntoView` from a card.
    await page.getByTestId('lab-jump-up').click();
    await page.waitForTimeout(400);

    const state = await scroller.evaluate((el) => ({
      free: el.classList.contains('chat-scroll--free'),
      gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    }));
    expect(state.gap, 'the view should have moved up off the bottom').toBeGreaterThan(100);
    expect(state.free, 'the pin must be released by a bare scroll').toBe(true);
    await expect(page.getByTestId('lab-pinned')).toHaveText('pinned: false');
  });

  test('a scroll up during generation is not fought by the follow animation', async ({ page }) => {
    // This is the reported symptom itself: while a turn streams, the lerp pulls
    // the viewport back to the bottom every frame, and a reader who scrolls up
    // to re-read something is dragged down again. The guard that marks "this
    // write is ours" is raised on every frame of that animation, so a release
    // that only listens for guard-free events cannot see the drag at all.
    test.setTimeout(30_000);
    await page.goto('/_design', { waitUntil: 'domcontentloaded' });
    const scroller = page.getByTestId('lab-scroller');
    await expect(scroller).toBeVisible();

    await page.getByTestId('lab-stream').click();
    // Let the animation settle into following the bottom.
    await page.waitForTimeout(1200);
    await expect(scroller).not.toHaveClass(/chat-scroll--free/);

    await page.getByTestId('lab-jump-up').click();
    // Long enough for many lerp frames to have run against the release.
    await page.waitForTimeout(1500);

    const state = await scroller.evaluate((el) => ({
      free: el.classList.contains('chat-scroll--free'),
      gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
    }));
    expect(state.free, 'the drag must release the pin mid-animation').toBe(true);
    expect(state.gap, 'the view must not be dragged back to the bottom').toBeGreaterThan(150);
  });
});
