/* ── PdfPager ─ continuous, page-accurate PDF reading, client-side ────────── */
/* Pages stack as paper cards in ONE scroll container with a floating
 * `Page N / M` chip pinned to the viewport's bottom edge (the reference's
 * anatomy: paper cards + a chip that does not scroll away). Rendering is
 * windowed — the page at the reading line, plus one either side — so a document
 * mounts as many cards as it has pages without rasterizing them all.
 *
 * Why client-side pdf.js and not the backend `render_pages` tool: that tool
 * shells out to LibreOffice for office formats, which a shipped Windows app
 * cannot assume, and its PDF path is a tool with no generic invoke route.
 * Here the bytes are already in the webview (dataUrl / path), so rendering is
 * local and offline.
 *
 * Three things this replaced were wrong rather than merely plain:
 *
 *  1. ONE canvas, one page at a time. Continuous reading is the reference's
 *     default and the only way to skim a generated report. Documents longer
 *     than `CONTINUOUS_MAX_PAGES` fall back to the single-page pager (stated
 *     limit, not a silent one): windowed rendering bounds work per scroll, but
 *     a 900-page document would still mount 900 card elements.
 *  2. Zoom magnified the RASTER — a CSS `transform: scale()` on the preview
 *     wrapper, so a 200% page was a 100%-rendered bitmap blown up and soft.
 *     The pager now takes the zoom factor, lays the pages out that much wider,
 *     and rasterizes at `width × devicePixelRatio`, so zoom buys real detail.
 *  3. The fill colour claimed to be "theme-resolved paper" while reading
 *     `getComputedStyle(canvas).backgroundColor` off an element whose own class
 *     list says `bg-white` — so it was white in every theme and the comment was
 *     the only thing themed. Paper is white on purpose here (the reference
 *     renders documents the same way, and its own iframe fallback in
 *     RightDrawerFileSection is `bg-white` for the light half too); the canvas
 *     paints the same palette value its card dresses in — the CSS keyword
 *     `white`, not an invented hex, and deliberately not a theme token, since
 *     paper that followed dark mode would be a bug.
 *
 * The page-1 thumbnail in file-reader.ts already proved page-1 rasterization
 * works; this generalizes that viewport math to any page. A CJK-heavy PDF may
 * still need the standard_fonts/cmaps assets — page-1 rasterization works
 * today, and a glyph gap there is a font-asset question, not a paging bug.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  CONTINUOUS_MAX_PAGES,
  MAX_RASTER_WIDTH,
  pageAtOffset,
  pageWindow,
} from '@/components/shell/pdf-pager-math';
// The document + page handle types, so the refs carry cleanup()/numPages/
// getPage and renderPageToCanvas takes a typed page — no `any`, which would
// otherwise trip ~15 no-unsafe-* warnings and blow the lint budget.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';

/** Same worker the attachment reader pins: bundled, same-origin, offline-safe. */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/* The pure half of this viewer — `CONTINUOUS_MAX_PAGES`, `MAX_RASTER_WIDTH`,
 *  `pageAtOffset`, `pageWindow` — lives in ./pdf-pager-math so this module
 *  exports a component and nothing else (a Fast Refresh boundary). */

/** Render one pdf.js page to a canvas at a target DISPLAY width. The raster is
 *  `pixelRatio` times that (bounded by MAX_RASTER_WIDTH in device pixels), with
 *  the CSS width pinned to the display size, so a HiDPI screen or a zoomed-in
 *  page gets real pixels instead of an upscaled bitmap. Returns false when there
 *  is no 2D context (jsdom, or a headless render with none), so the caller can
 *  fall back rather than draw blank. */
async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  pixelRatio = 1,
): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false; // jsdom has no 2D context; the card still occupies its box.

  const base = page.getViewport({ scale: 1 });
  const deviceWidth = Math.min(Math.max(cssWidth, 1) * pixelRatio, MAX_RASTER_WIDTH);
  const viewport = page.getViewport({ scale: deviceWidth / Math.max(base.width, 1) });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.round(cssWidth)}px`;
  canvas.style.height = 'auto';
  // A document page is paper. See the header note: this used to read the
  // resolved background off a `bg-white` element and call that theming.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // `canvas` is the current pdf.js API; `canvasContext` is the deprecated
  // back-compat form (passing it alone is a type error in 6.x).
  await page.render({ canvas, viewport }).promise;
  return true;
}

/** Decode a `data:application/pdf;base64,...` URL to the bytes pdf.js wants. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (meta.includes(';base64')) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // Percent-encoded (non-base64) data URL.
  return new TextEncoder().encode(decodeURIComponent(body));
}

export function PdfPager({
  src,
  label,
  className,
  zoom = 1,
}: {
  /** Where the PDF bytes come from: a data: URL, or an http(s) URL. */
  src: string;
  /** Accessible name / filename for the document. */
  label: string;
  className?: string;
  /** Layout + raster scale. 1 = fit the pane; 2 = twice as wide AND twice the
   *  pixels. Owned by the viewer's zoom controls. */
  zoom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null); // single-page fallback
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderToken = useRef(0);
  /** page number → the display width it was last rasterized at, so a zoom
   *  change re-renders and a scroll back does not. */
  const rasterizedAt = useRef(new Map<number, number>());
  /** Pages whose canvas currently has a `render()` in flight. pdf.js refuses a
   *  second render on the same canvas ("Cannot use the same canvas during
   *  multiple render() operations"), which used to surface as a dead pane. */
  const rendering = useRef(new Set<number>());
  /** The width a render should be aiming at, readable from a render that started
   *  before the last zoom — a pass cannot see a newer `displayWidth` otherwise. */
  const displayWidthRef = useRef(0);

  const [numPages, setNumPages] = useState(0);
  /** height / width per page, measured before the first paint so the cards
   *  reserve their true space (no jumping as pages rasterize). */
  const [ratios, setRatios] = useState<Map<number, number>>(new Map());
  const [page, setPage] = useState(1);
  const [paneWidth, setPaneWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const continuous = numPages > 0 && numPages <= CONTINUOUS_MAX_PAGES;

  // Load the document once. `cleanup` cancels any in-flight render on unmount
  // so a fast close does not throw mid-render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setRatios(new Map());
    setPage(1);
    rasterizedAt.current = new Map();
    rendering.current.clear();
    // A new document opens at its own top. Without this the container kept the
    // previous file's scrollTop while the chip reset to `Page 1` — same pane,
    // previous position. (The ref arrays are left to React: unmounted cards are
    // nulled by their own ref callbacks, and every read below slices to the
    // card count before trusting an entry.)
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = 0;
    // The IIFE returns a promise; `void` it explicitly (cancellation is handled
    // by the `cancelled` flag + cleanup below, not by awaiting here).
    void (async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
        // A data: URL carries bytes directly; an http(s) URL is fetched by
        // pdf.js. `withCredentials` off — these are local/same-origin assets.
        const isData = src.startsWith('data:');
        const doc = await pdfjsLib.getDocument(
          isData ? { data: dataUrlToBytes(src) } : { url: src },
        ).promise;
        if (cancelled) {
          void doc.cleanup();
          return;
        }
        pdfRef.current = doc;
        // Measuring is a round trip to the worker per page and it gates the
        // first paint (`loading`), so it is bounded by the page count the
        // continuous mode will actually mount — and skipped outright for a
        // document over the cap, which renders single-page and never reads a
        // ratio. Before that guard those documents measured 40 pages they
        // could not use before showing anything.
        const measured = new Map<number, number>();
        if (doc.numPages <= CONTINUOUS_MAX_PAGES) {
          for (let i = 1; i <= doc.numPages; i++) {
            const pdfPage = await doc.getPage(i);
            const base = pdfPage.getViewport({ scale: 1 });
            measured.set(i, base.height / Math.max(base.width, 1));
            if (cancelled) return;
          }
        }
        setRatios(measured);
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not open PDF');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      const doc = pdfRef.current;
      pdfRef.current = null;
      void doc?.cleanup();
    };
  }, [src]);

  // The display width of one page: the pane, times zoom. Measured rather than
  // assumed so the cards are laid out at the width they will rasterize at.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setPaneWidth(Math.max(0, el.clientWidth - 32)); // minus p-4
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const displayWidth = paneWidth > 0 ? Math.round(paneWidth * zoom) : 0;
  displayWidthRef.current = displayWidth;

  /** The page under the reading line, read from the MOUNTED cards only.
   *
   *  A stale trailing entry (a shorter document opened in the same pane) reads
   *  as `0`, and `pageAtOffset` treats `0` as "at or above the line" — measured:
   *  `pageAtOffset([16,632,0,0,0], 632)` reported page 5 on a two-page document,
   *  which also disabled both pager buttons (`page >= numPages`) and left
   *  `pageWindow(5, 2)` empty, so nothing rasterized at all. Slicing to the card
   *  count removes the stale tail; the clamp is the second belt. */
  const readingLine = useCallback(
    (el: HTMLDivElement) => {
      const count = Math.min(numPages, CONTINUOUS_MAX_PAGES);
      if (count <= 0) return 1;
      const tops = cardRefs.current.slice(0, count).map((c) => c?.offsetTop ?? 0);
      return Math.max(1, Math.min(numPages, pageAtOffset(tops, el.scrollTop)));
    },
    [numPages],
  );

  /** Card geometry rides on CSS custom properties rather than an inline `style`
   *  object. Both values are measured (the pane's width, each page's own
   *  proportions) and the declarations belong to the stylesheet, where a theme
   *  or a caller can override them — the same reason RightDrawer publishes its
   *  width as `--august-drawer-w` instead of setting it inline.
   *
   *  `useLayoutEffect`, not `useEffect`: the ratio has to land in the same paint
   *  the cards mount in, or every card shows one frame at the canvas's
   *  unmeasured height — the layout jump these proportions exist to prevent. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (displayWidth > 0) el.style.setProperty('--pdf-page-w', `${displayWidth}px`);
    else el.style.removeProperty('--pdf-page-w');
    // A width change re-lays out EVERY card, so the page under the reading line
    // can change with no scroll event to say so — measured: zoom 1→2 on a
    // two-page fixture fired 0 scroll events and moved the reading line a full
    // page while the chip kept the old number. Recomputing here, in the same
    // commit that moved the layout, keeps the chip and both buttons describing
    // what the reader is actually looking at.
    if (!continuous || loading || displayWidth <= 0) return;
    const next = readingLine(el);
    setPage((p) => (p === next ? p : next));
  }, [displayWidth, loading, numPages, continuous, readingLine]);

  useLayoutEffect(() => {
    cardRefs.current.forEach((el, i) => {
      if (!el) return;
      const ratio = ratios.get(i + 1);
      // `1 / ratio`, not the bare number: CSS `aspect-ratio: 1.29` means
      // width/height, while `ratios` is height/width (a portrait page is > 1).
      // The bare form laid every page out landscape and clipped the bottom 40%.
      if (ratio) el.style.setProperty('--pdf-page-ratio', `1 / ${ratio}`);
      else el.style.removeProperty('--pdf-page-ratio');
    });
  }, [ratios, numPages, loading]);

  const pixelRatio = () =>
    typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

  const renderCards = useCallback(
    async (center: number) => {
      const doc = pdfRef.current;
      if (!doc || displayWidth <= 0) return;
      const count = Math.min(numPages, CONTINUOUS_MAX_PAGES);
      const wants = pageWindow(center, count);
      const token = ++renderToken.current;

      // Rasters are where this viewer's memory goes — ~30 MB per page at the
      // cap — and nothing used to release them: scrolling a 40-page document end
      // to end held roughly 1.2 GB of backing stores. Pages outside the window
      // give theirs back. The card keeps its measured ratio box, so the layout
      // does not move, and `rasterizedAt` forgets the page so scrolling back
      // re-renders it. A page mid-render is left alone (its own pass owns it).
      const keep = new Set(wants);
      for (const n of [...rasterizedAt.current.keys()]) {
        if (keep.has(n) || rendering.current.has(n)) continue;
        const cold = pageCanvasRefs.current[n - 1];
        if (cold) {
          cold.width = 0;
          cold.height = 0;
          cold.style.width = '';
          cold.style.height = '';
        }
        rasterizedAt.current.delete(n);
      }

      for (const n of wants) {
        if (token !== renderToken.current) return; // a newer pass superseded this
        const canvas = pageCanvasRefs.current[n - 1];
        if (!canvas || rasterizedAt.current.get(n) === displayWidth) continue;
        if (rendering.current.has(n)) continue; // one render per canvas at a time
        rendering.current.add(n);
        let width = displayWidth;
        try {
          // At most two passes per claim: the width this pass wants, and a newer
          // one that arrived while it rendered. Bounded on purpose — an
          // unbounded "keep up with zoom" loop would spin forever on a canvas
          // that cannot render at all (a renderer with no 2D context, where
          // `renderPageToCanvas` returns false and nothing is ever recorded).
          for (let attempt = 0; attempt < 2; attempt++) {
            const pdfPage = await doc.getPage(n);
            if (token !== renderToken.current) return;
            const ok = await renderPageToCanvas(pdfPage, canvas, width, pixelRatio());
            if (!ok) break;
            rasterizedAt.current.set(n, width);
            if (width === displayWidthRef.current) break;
            width = displayWidthRef.current;
          }
        } catch (e) {
          if (token === renderToken.current) {
            setError(e instanceof Error ? e.message : 'Could not render page');
          }
        } finally {
          rendering.current.delete(n);
        }
      }
    },
    [displayWidth, numPages],
  );

  // Single-page fallback (documents over the cap).
  const drawSingle = useCallback(
    async (pageNumber: number) => {
      const doc = pdfRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;
      const token = ++renderToken.current;
      try {
        const pdfPage = await doc.getPage(pageNumber);
        if (token !== renderToken.current) return;
        const width = displayWidth || canvas.parentElement?.clientWidth || 720;
        await renderPageToCanvas(pdfPage, canvas, width, pixelRatio());
      } catch (e) {
        if (token === renderToken.current) {
          setError(e instanceof Error ? e.message : 'Could not render page');
        }
      }
    },
    [displayWidth],
  );

  useEffect(() => {
    if (loading || error) return;
    if (continuous) void renderCards(page);
    else if (numPages > 0) void drawSingle(page);
  }, [loading, error, continuous, numPages, page, displayWidth, renderCards, drawSingle]);

  /** Scroll a page to the reading line. Setting `scrollTop` directly (rather
   *  than `scrollIntoView`) keeps the ancestor list from scrolling too — a
   *  fullscreen overlay and the drawer are separate scroll contexts. */
  const scrollToPage = (n: number) => {
    const el = scrollRef.current;
    const card = cardRefs.current[n - 1];
    if (!el || !card) return;
    // `offsetTop` is measured from the nearest POSITIONED ancestor — the wrapper
    // at the top of this component, not the scroller — so the two agree only
    // while the scroller sits at that ancestor's origin. Subtracting the
    // scroller's own offset states the invariant instead of assuming it: a
    // border, padding or margin on the wrapper would otherwise break every page
    // jump (and the reading line with it) silently.
    el.scrollTop = card.offsetTop - el.offsetTop;
    setPage(n);
  };

  const go = (delta: number) => {
    const next = Math.max(1, Math.min(numPages, page + delta));
    if (continuous) scrollToPage(next);
    else setPage(next);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !continuous) return;
    const next = readingLine(el);
    setPage((p) => (p === next ? p : next));
  };

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 p-8 text-center', className)}>
        <p className="text-sm font-medium text-foreground">Couldn’t read this PDF</p>
        <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className={cn('relative flex h-full min-h-0 flex-col', className)} data-testid="pdf-pager">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        // `items-start`, not `items-center`: a page wider than the pane (zoom > 1)
        // overflows a CENTERED flex line symmetrically, and the negative half is
        // unreachable — measured 600px scroller / 900px page: the card's left
        // edge sat at −150 at scrollLeft 0 (max 166), so one side of every page
        // was always cut off, a failure mode the previous `transform: scale()`
        // wrapper could not produce. `mx-auto` on the card centres it while it
        // fits and collapses to 0 once it overflows, leaving the whole page
        // reachable by scrolling.
        className="flex min-h-0 flex-1 flex-col items-start gap-4 overflow-auto bg-sunken p-4 chat-scroll"
        data-testid="pdf-pager-scroll"
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {continuous ? (
          // Paper cards. Each page's proportions are measured before the first
          // paint and published as `--pdf-page-ratio` (see the effects above), so
          // a mixed-size document reserves each card's true height instead of
          // jumping as the pages rasterize.
          Array.from({ length: Math.min(numPages, CONTINUOUS_MAX_PAGES) }, (_, i) => i + 1).map((n) => (
            <div
              key={n}
              ref={(el) => { cardRefs.current[n - 1] = el; }}
              data-testid="pdf-page"
              data-page={n}
              className={cn(
                // `100%` / `auto` are the first-paint defaults; the measured
                // values arrive as custom properties on the scroller and the card.
                'mx-auto w-[var(--pdf-page-w,100%)] aspect-[var(--pdf-page-ratio,auto)] shrink-0 overflow-hidden rounded border border-border/40 bg-white shadow-sm',
                loading && 'invisible',
              )}
            >
              <canvas
                ref={(el) => { pageCanvasRefs.current[n - 1] = el; }}
                aria-label={`Page ${n} of ${numPages} of ${label}`}
                className="block h-full w-full"
              />
            </div>
          ))
        ) : (
          <canvas
            ref={canvasRef}
            aria-label={`Page ${page} of ${numPages} of ${label}`}
            className={cn('mx-auto max-w-full rounded border border-border/40 bg-white shadow-sm', loading && 'invisible')}
          />
        )}
      </div>

      {/* The chip lives OUTSIDE the scroller: an absolutely positioned child of a
          scroll container scrolls with its content, which is how the old footer
          strip's equivalent ended up out of view in the reference. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div
          className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background/95 px-1.5 py-1 shadow-elev-raised backdrop-blur"
          data-testid="pdf-pager-controls"
        >
          {/* `icon-sm` IS `size-7`. The footer this replaced passed
              `size="icon"` (size-9) plus `className="size-7"` — two competing
              utilities of equal specificity, so which one won was class order,
              not intent. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => go(-1)}
            disabled={page <= 1 || loading}
            aria-label="Previous page"
            data-testid="pdf-pager-prev"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span
            className="min-w-[6rem] text-center text-2xs tabular-nums text-muted-foreground"
            data-testid="pdf-pager-page"
          >
            {loading ? 'Loading…' : `Page ${page} / ${numPages}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => go(1)}
            disabled={page >= numPages || loading}
            aria-label="Next page"
            data-testid="pdf-pager-next"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
