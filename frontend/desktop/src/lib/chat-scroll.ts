/**
 * Scroll thresholds for the chat transcript — one owner.
 *
 * These were two magic numbers in two files (a near-bottom re-pin test in
 * ChatThread and the scroll-to-top trigger height in ScrollToTopButton),
 * which is how they drifted apart over time.
 */

/** Re-pin when the user scrolls back within this distance of the bottom. */
export const NEAR_BOTTOM_PX = 80;

/** The scroll-to-top affordance appears past this scrollTop. */
export const SHOW_SCROLL_TO_TOP_PX = 200;

/** Fraction of the viewport a streaming row may occupy before the
 *  follow engine stops dragging the viewport with it (see
 *  useStickToBottomScroll — a message taller than the viewport has no
 *  stable anchor, so holding position beats yanking). */
export const OVERSIZE_STREAMING_ROW_RATIO = 0.9;
