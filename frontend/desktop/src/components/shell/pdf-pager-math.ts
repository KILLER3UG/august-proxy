/* ── PdfPager math ─ the pure half of the continuous document viewer ─────── */
/*
 * Separate from `PdfPager.tsx` on purpose: the pager exports a component, and a
 * component module that also exports constants is a Fast Refresh boundary
 * (`react-refresh/only-export-components`) — flipping any of these in a dev
 * session would remount the viewer instead of updating it. It also puts the
 * testable part in a file with no pdf.js, no worker and no DOM: the scroll math
 * is where the bugs live, and it needs none of the three.
 */

/** Stacked mode stops here; past it the single-page pager is used instead. */
export const CONTINUOUS_MAX_PAGES = 40;

/** The raster stops growing here, in DEVICE pixels. Zoom drives the page's
 *  layout width, so 5× over a 700px pane would otherwise ask pdf.js for a
 *  3500×4500 CSS-pixel page — ~250 MB of RGBA at DPR 2, per page. Past this
 *  bound the page keeps scaling and the raster stops sharpening, which is also
 *  what the browser's own PDF viewers do. 2400 device px ≈ 31 MB RGBA. */
export const MAX_RASTER_WIDTH = 2400;

/** Which page sits at the reading line: the LAST card whose top edge is at or
 *  above `scrollTop`, 1-based. Pure so the scroll math is testable without a
 *  browser (the raster cannot be).
 *
 *  "Last whose top is above the line" rather than "first still visible": a tall
 *  card scrolled halfway up has its top above the line, and the reader is
 *  looking at the tall card — a first-visible rule would flip the chip to the
 *  next page the moment the previous one's bottom edge reached the line.
 *
 *  The 1px lead absorbs a fractional `scrollTop` (mid-momentum scrolling reports
 *  one) against an integer `offsetTop`. */
export function pageAtOffset(tops: readonly number[], scrollTop: number): number {
  let found = 1;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= scrollTop + 1) found = i + 1;
    else break;
  }
  return found;
}

/** The 1-based pages to rasterize around the current one, inclusive bounds. */
export function pageWindow(page: number, numPages: number, radius = 1): number[] {
  const out: number[] = [];
  for (let p = Math.max(1, page - radius); p <= Math.min(numPages, page + radius); p++) out.push(p);
  return out;
}
