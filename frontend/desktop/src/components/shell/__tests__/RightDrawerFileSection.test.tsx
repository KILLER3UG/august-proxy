import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RightDrawerFileSection } from '../RightDrawerFileSection';
import type { FileAttachment } from '@/types/chat';

const TEXT_FILE: FileAttachment = {
  name: 'notes.md',
  size: '12 KB',
  type: 'text',
  content: 'hello world\nsecond line',
};

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
      document.querySelectorAll('[data-testid="file-preview-zoom-in"]')[0]!,
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

  it('renders HTML documents LIVE with a preview/source toggle', () => {
    setup({
      name: 'embeddings-explainer.html',
      size: '6 KB',
      type: 'text',
      content:
        '<!doctype html><html><head><style>body{color:#fff}</style></head>' +
        '<body><canvas id="c"></canvas><script>let x=1;</script></body></html>',
    });
    // Live iframe by default (sandboxed, scripts allowed)…
    const live = document.querySelector(
      '[data-testid="file-preview-html-live"] iframe[sandbox]',
    );
    expect(live).toBeTruthy();
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
    setup(); // notes.md
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
    expect(eye.title).toBe('No preview available for PPTX');
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
