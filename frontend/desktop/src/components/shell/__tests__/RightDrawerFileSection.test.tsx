import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightDrawerFileSection } from '../RightDrawerFileSection';
import type { FileAttachment } from '@/types/chat';
import { usePreferencesStore, type LiveHtmlPreview } from '@/lib/preferences';

const TEXT_FILE: FileAttachment = {
  name: 'notes.txt',
  size: '12 KB',
  type: 'text',
  content: 'hello world\nsecond line',
};

function setLivePref(mode: LiveHtmlPreview) {
  usePreferencesStore.setState({ liveHtmlPreview: mode });
}

function setup(file: FileAttachment = TEXT_FILE) {
  return render(<RightDrawerFileSection file={file} />);
}

function openOverlay() {
  fireEvent.click(document.querySelector('[data-testid="file-preview-fullscreen"]')!);
}

describe('RightDrawerFileSection fullscreen preview', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('offers a fullscreen toggle beside the zoom controls', () => {
    setup();
    expect(
      document.querySelector('[data-testid="file-preview-fullscreen"]'),
    ).toBeTruthy();
  });

  it('expands to a full-window overlay and exits back to the drawer', () => {
    setup();
    openOverlay();
    const overlay = document.querySelector('[data-testid="file-preview-overlay"]');
    expect(overlay).toBeTruthy();
    // Portaled above everything, fixed to the window.
    expect(overlay!.parentElement).toBe(document.body);
    expect((overlay as HTMLElement).className).toContain('fixed');
    // Zoom controls live in the overlay too.
    expect(
      document.querySelectorAll('[data-testid="file-preview-zoom-level"]').length,
    ).toBe(2);
    // Exit button closes the overlay…
    fireEvent.click(
      document.querySelector('[data-testid="file-preview-fullscreen-exit"]')!,
    );
    expect(document.querySelector('[data-testid="file-preview-overlay"]')).toBeNull();
    // …and the drawer preview survives underneath.
    expect(
      document.querySelector('[data-testid="right-drawer-file-preview"]'),
    ).toBeTruthy();
  });

  it('Escape exits the overlay without closing the drawer behind it', () => {
    setup();
    openOverlay();
    expect(document.querySelector('[data-testid="file-preview-overlay"]')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.querySelector('[data-testid="file-preview-overlay"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="right-drawer-file-preview"]'),
    ).toBeTruthy();
  });

  it('zoom level is shared between the drawer canvas and the overlay', () => {
    setup();
    openOverlay();
    // Two canvases now (drawer + overlay); bump zoom once.
    fireEvent.click(
      document.querySelectorAll('[data-testid="file-preview-zoom-in"]')[0],
    );
    const levels = Array.from(
      document.querySelectorAll('[data-testid="file-preview-zoom-level"]'),
    ).map((el) => el.textContent);
    expect(levels).toEqual(['125%', '125%']);
  });

  it('image previews get the same fullscreen treatment', () => {
    setup({
      name: 'shot.png',
      size: '84 KB',
      type: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    openOverlay();
    const overlay = document.querySelector('[data-testid="file-preview-overlay"]');
    expect(overlay?.querySelector('img')).toBeTruthy();
  });

  it('renders HTML in a fully sandboxed static preview with a source toggle', () => {
    setup({
      name: 'embeddings-explainer.html',
      size: '6 KB',
      type: 'text',
      content:
        '<!doctype html><html><head><style>body{color:#fff}</style></head>' +
        '<body><canvas id="c"></canvas><script>let x=1;</script></body></html>',
    });
    // HTML preview remains readable while scripts and other active content
    // stay disabled inside the untrusted attachment.
    const preview = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live"] iframe[sandbox]',
    );
    expect(preview).toBeTruthy();
    expect(preview?.getAttribute('sandbox')).toBe('');
    expect(preview?.title).toBe('HTML preview of embeddings-explainer.html');
    // …with a Source toggle showing code instead.
    fireEvent.click(document.querySelector('[data-testid="html-preview-tab-source"]')!);
    expect(screen.getByText(/<!doctype html>/i)).toBeTruthy();
    fireEvent.click(document.querySelector('[data-testid="html-preview-tab-render"]')!);
    expect(
      document.querySelector('[data-testid="file-preview-html-live"] iframe'),
    ).toBeTruthy();
  });

  it('shows Eye/Code2 icon toggles in the header for HTML (Bug 7b)', () => {
    setup({
      name: 'explainer.html',
      size: '4 KB',
      type: 'text',
      content: '<!doctype html><html><body>hi</body></html>',
    });
    const eye = document.querySelector('[data-testid="html-preview-tab-render"]')!;
    const code = document.querySelector('[data-testid="html-preview-tab-source"]')!;
    // Both live in the section header (before the zoom controls).
    expect(eye.closest('[data-testid="right-drawer-file-preview"] > div')).toBeTruthy();
    expect(eye.getAttribute('aria-label')).toMatch(/preview/i);
    expect(code.getAttribute('aria-label')).toMatch(/source/i);
    // HTML supports both sides — neither is disabled.
    expect((eye as HTMLButtonElement).disabled).toBe(false);
    expect((code as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the Eye toggle for non-HTML text with an explanatory tooltip', () => {
    setup(); // notes.txt
    const eye = document.querySelector(
      '[data-testid="html-preview-tab-render"]',
    ) as HTMLButtonElement;
    const code = document.querySelector(
      '[data-testid="html-preview-tab-source"]',
    ) as HTMLButtonElement;
    expect(eye.disabled).toBe(true);
    expect(eye.title).toMatch(/no rendered preview/i);
    expect(code.disabled).toBe(false);
    // Source view stays the rendered text preview.
    expect(screen.getByText('hello world')).toBeTruthy();
  });

  it('enables the Eye toggle for markdown files with rich rendered preview', () => {
    setup({
      name: 'notes.md',
      size: '12 KB',
      type: 'text',
      content: '# Hello\nMarkdown preview content',
    });
    const eye = document.querySelector(
      '[data-testid="html-preview-tab-render"]',
    ) as HTMLButtonElement;
    const code = document.querySelector(
      '[data-testid="html-preview-tab-source"]',
    ) as HTMLButtonElement;
    expect(eye.disabled).toBe(false);
    expect(code.disabled).toBe(false);
    expect(document.querySelector('[data-testid="file-preview-markdown"]')).toBeTruthy();
  });

  it('names the disabled-preview tooltip for PPT/PPTX files', () => {
    setup({
      name: 'deck.pptx',
      size: '2 MB',
      type: 'text',
      content: 'binary-ish stand-in',
    });
    const eye = document.querySelector(
      '[data-testid="html-preview-tab-render"]',
    ) as HTMLButtonElement;
    expect(eye.disabled).toBe(true);
    // The tooltip names the format AND points at the source text that IS
    // available — an office file has no client-side renderer, but its extracted
    // text is still readable, so say both rather than a bare "no preview".
    expect(eye.title).toBe('No rendered preview for PPTX — the source text is available');
  });

  it('treats a PDF with bytes in the webview as renderable (Eye enabled, pager mounts)', () => {
    // A PDF's extracted text alone cannot paginate — it needs the bytes. With a
    // dataUrl present, the Eye toggle targets the page-by-page pager, and the
    // source view (extracted text) stays reachable behind the Code2 toggle.
    setup({
      name: 'report.pdf',
      size: '2 MB',
      type: 'text',
      content: '--- Page 1 ---\nsome extracted text',
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    });
    const eye = document.querySelector(
      '[data-testid="html-preview-tab-render"]',
    ) as HTMLButtonElement;
    expect(eye.disabled).toBe(false);
    // The pager is the rendered view (it will show a loading state in jsdom,
    // where pdf.js has no 2D canvas — the controls and label still mount).
    expect(document.querySelector('[data-testid="file-preview-pdf"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="pdf-pager"]')).toBeTruthy();
    // Source view still reachable: the extracted text the model reads.
    fireEvent.click(document.querySelector('[data-testid="html-preview-tab-source"]')!);
    expect(screen.getByText(/some extracted text/)).toBeTruthy();
  });

  it('a PDF with no bytes in the webview is NOT renderable (text view only)', () => {
    // Extracted text without a dataUrl/previewUrl cannot paginate, so the Eye
    // stays disabled — no pager mounts from text alone.
    setup({
      name: 'report.pdf',
      size: '2 MB',
      type: 'text',
      content: '--- Page 1 ---\nsome extracted text',
    });
    const eye = document.querySelector(
      '[data-testid="html-preview-tab-render"]',
    ) as HTMLButtonElement;
    expect(eye.disabled).toBe(true);
    expect(document.querySelector('[data-testid="pdf-pager"]')).toBeNull();
  });

  it('hides the toggle pair for image previews', () => {
    setup({
      name: 'shot.png',
      size: '84 KB',
      type: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    expect(document.querySelector('[data-testid="html-preview-tab-render"]')).toBeNull();
    expect(document.querySelector('[data-testid="html-preview-tab-source"]')).toBeNull();
  });
});

/* ── Live artifact preview (Stage 1) ───────────────────────────────────────
 * A `srcdoc` iframe inherits the shell CSP (`script-src 'self'`), so an
 * inline-script figure used to render inert. Session-produced files now go
 * through GET /api/workbench/artifact/html, served from the backend's own
 * origin under a document-scoped CSP, with `allow-scripts` and WITHOUT
 * `allow-same-origin` (opaque origin — no parent read, no Tauri IPC). */

describe('RightDrawerFileSection live artifact preview', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLivePref('auto');
  });

  const SESSION_HTML: FileAttachment = {
    name: 'figure.html',
    size: '6 KB',
    type: 'text',
    content:
      '<!doctype html><html><body><script>let spin=1;</script></body></html>',
    savedPath: 'C:/ws/.aug/attachments/sess-1/figure.html',
  };

  const OPENED_HTML: FileAttachment = {
    name: 'report.html',
    size: '6 KB',
    type: 'text',
    content:
      '<!doctype html><html><body><script>let x=1;</script></body></html>',
    path: 'C:/Users/me/report.html',
  };

  it('serves a session-produced HTML file from the artifact route in a script-capable sandbox', () => {
    setup(SESSION_HTML);
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live-iframe"]',
    );
    expect(frame).toBeTruthy();
    expect(frame?.src).toContain('/api/workbench/artifact/html');
    expect(frame?.src).toContain(encodeURIComponent(SESSION_HTML.savedPath!));
    const sandbox = frame?.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    // An opaque origin: no parent read, no Tauri IPC reach.
    expect(sandbox).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('srcdoc')).toBeNull();
  });

  it('keeps an arbitrary opened file on the static srcDoc render by default', () => {
    setup(OPENED_HTML);
    expect(
      document.querySelector('[data-testid="file-preview-html-live-iframe"]'),
    ).toBeNull();
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live"] iframe[sandbox]',
    );
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('srcdoc')).toContain('let x=1;');
  });

  it("honors the preference override: 'off' pins a session file static, 'on' opens a file with a path", () => {
    setLivePref('off');
    setup(SESSION_HTML);
    expect(
      document.querySelector('[data-testid="file-preview-html-live-iframe"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="file-preview-html-live"] iframe[srcdoc]'),
    ).toBeTruthy();

    setLivePref('on');
    setup(OPENED_HTML);
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live-iframe"]',
    );
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
  });

  it('renders a standalone SVG as a live document too', () => {
    setup({
      name: 'figure.svg',
      size: '4 KB',
      type: 'text',
      content: '<svg xmlns="http://www.w3.org/2000/svg"><script>turn()</script><rect/></svg>',
      savedPath: 'C:/ws/.aug/attachments/sess-1/figure.svg',
    });
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live-iframe"]',
    );
    expect(frame).toBeTruthy();
    expect(frame?.src).toContain('figure.svg');
  });

  it('the Source toggle still shows the raw text of a live document', () => {
    setup(SESSION_HTML);
    fireEvent.click(document.querySelector('[data-testid="html-preview-tab-source"]')!);
    expect(screen.getByText(/let spin=1;/i)).toBeTruthy();
    expect(
      document.querySelector('[data-testid="file-preview-html-live-iframe"]'),
    ).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="html-preview-tab-render"]')!);
    expect(
      document.querySelector('[data-testid="file-preview-html-live-iframe"]'),
    ).toBeTruthy();
  });

  it('a live document with no path on disk falls back to the static render', () => {
    // savedPath absent AND path absent (pure paste/upload) — nothing to serve.
    setup({
      name: 'inline.html',
      size: '2 KB',
      type: 'text',
      content: '<!doctype html><html><body><script>1</script></body></html>',
    });
    expect(
      document.querySelector('[data-testid="file-preview-html-live-iframe"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="file-preview-html-live"] iframe[srcdoc]'),
    ).toBeTruthy();
  });

  it('a file opened from a session deliverable card previews live', () => {
    // openFileInDrawer stamps sessionAuthored on card-opened files — this is
    // the create_html_artifact output path, and it must animate by default.
    setup({ ...OPENED_HTML, sessionAuthored: true });
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-preview-html-live-iframe"]',
    );
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame?.src).toContain(encodeURIComponent(OPENED_HTML.path!));
  });
});
