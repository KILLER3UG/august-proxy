/* ── PdfPager ─ page-by-page PDF reading, client-side ─────────────────────── */
/* Renders a PDF one page at a time with Page N / M and prev/next, using the
 * same bundled, same-origin pdf.js worker the attachment reader uses (no
 * network — see lib/file-reader.ts for why the worker is a `?url` import).
 *
 * Why client-side pdf.js and not the backend `render_pages` tool: that tool
 * shells out to LibreOffice for office formats, which a shipped Windows app
 * cannot assume, and its PDF path is a tool with no generic invoke route.
 * Here the bytes are already in the webview (dataUrl / path), so rendering is
 * local and offline.
 *
 * The page-1 thumbnail in file-reader.ts already proved page-1 rasterization
 * works; this generalizes that viewport math to any page. A CJK-heavy PDF may
 * still need the standard_fonts/cmaps assets — page-1 rasterization works
 * today, and a glyph gap there is a font-asset question, not a paging bug.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
// The document + page handle types, so the refs carry cleanup()/numPages/
// getPage and renderPageToCanvas takes a typed page — no `any`, which would
// otherwise trip ~15 no-unsafe-* warnings and blow the lint budget.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';

/** Same worker the attachment reader pins: bundled, same-origin, offline-safe. */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Render one pdf.js page to a canvas at a target display width. The viewport
 *  math is the shared primitive the attachment thumbnail also needs. Returns
 *  false when there is no 2D context (jsdom, or a headless render with none),
 *  so the caller can fall back rather than draw a blank page. */
async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  targetWidth: number,
): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false; // jsdom has no 2D context; degrade to the text view.

  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.25, Math.min(2.5, targetWidth / Math.max(base.width, 1)));
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  // A PDF page is paper — fill it with the theme's background so a light or
  // dark theme keeps the page in step rather than a hardcoded hex. Resolved at
  // runtime from the canvas's computed style (it inherits the document theme).
  const paper = typeof getComputedStyle === 'function'
    ? getComputedStyle(canvas).backgroundColor || 'white'
    : 'white';
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // `canvas` is the current pdf.js API; `canvasContext` is the deprecated
  // back-compat form (passing it alone is a type error in 6.x).
  await page.render({ canvas, viewport }).promise;
  return true;
}

export function PdfPager({
  src,
  label,
  className,
}: {
  /** Where the PDF bytes come from: a data: URL, or an http(s) URL. */
  src: string;
  /** Accessible name / filename for the document. */
  label: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderToken = useRef(0);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the document once. `destroy` cancels any in-flight render on unmount
  // so a fast close does not throw mid-render.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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
        setNumPages(doc.numPages);
        setPage(1);
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

  const draw = useCallback(
    async (pageNumber: number) => {
      const doc = pdfRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;
      const token = ++renderToken.current;
      try {
        const pdfPage = await doc.getPage(pageNumber);
        if (token !== renderToken.current) return; // a newer render superseded this
        const width = canvas.parentElement?.clientWidth || 720;
        await renderPageToCanvas(pdfPage, canvas, width);
      } catch (e) {
        if (token === renderToken.current) {
          setError(e instanceof Error ? e.message : 'Could not render page');
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!loading && numPages > 0) void draw(page);
  }, [loading, numPages, page, draw]);

  const go = (delta: number) =>
    setPage((p) => Math.max(1, Math.min(numPages, p + delta)));

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 p-8 text-center', className)}>
        <p className="text-sm font-medium text-foreground">Couldn’t read this PDF</p>
        <p className="max-w-sm text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)} data-testid="pdf-pager">
      <div className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-sunken p-4 chat-scroll">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}
        <canvas
          ref={canvasRef}
          aria-label={`Page ${page} of ${numPages} of ${label}`}
          className={cn('max-w-full rounded border border-border/40 bg-white shadow-sm', loading && 'invisible')}
        />
      </div>
      {/* Page controls live INSIDE the pager body, not the viewer header:
          PreviewCanvas is deliberately rendered twice (drawer + fullscreen)
          from one component, so a header badge would force the header to know
          per-canvas state. */}
      <div
        className="flex shrink-0 items-center justify-center gap-2 border-t border-border/40 px-3 py-1.5"
        data-testid="pdf-pager-controls"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => go(-1)}
          disabled={page <= 1 || loading}
          aria-label="Previous page"
          data-testid="pdf-pager-prev"
          className="size-7"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-[6rem] text-center text-2xs tabular-nums text-muted-foreground">
          {loading ? 'Loading…' : `Page ${page} / ${numPages}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => go(1)}
          disabled={page >= numPages || loading}
          aria-label="Next page"
          data-testid="pdf-pager-next"
          className="size-7"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
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
