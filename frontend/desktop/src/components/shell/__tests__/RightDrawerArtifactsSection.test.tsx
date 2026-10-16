/** The artifacts panel groups by provenance, in the reference's shape.
 *
 *  Reference: Screenshot 2026-10-08 171126 — a "Artifacts" title with a
 *  Download-all at the right, one row per produced file (tile, name,
 *  `Document · PDF`, a folder action), then a "Content" heading over a
 *  thumbnail grid of the files the user handed in.
 *
 *  The panel used to be a flat list behind four count pills (`All · 0`,
 *  `Files · 0`, `Images · 0`, `Links · 0`) that said nothing about where a
 *  file came from, and it carried a per-row Download button that cannot work:
 *  a produced file's `href` is a filesystem path, and an `<a href>` built from
 *  `C:\Dev\...\x.md` resolves to `file:///C:/Dev...x.md` (measured in
 *  Chromium), which a `tauri://` webview will not navigate to anyway.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RightDrawerArtifactsSection } from '../RightDrawerArtifactsSection';
import type { ChatMessage } from '@/types/chat';

const streamRef = vi.hoisted(() => ({ messages: [] as ChatMessage[] }));

vi.mock('@/sections/chat/hooks/useSessionStream', () => ({
  useSessionStream: () => ({ messages: streamRef.messages }),
}));

vi.mock('@/lib/tauri-shell', () => ({
  revealInFolder: vi.fn(async () => {}),
  openExternal: vi.fn(async () => {}),
  selectDirectory: vi.fn(async () => null),
  copyFilesToDir: vi.fn(async () => null),
}));

const PRODUCED: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  content: 'Wrote the report. See [the spec](https://example.com/a/b).',
  timestamp: '2026-10-16T09:00:00.000Z',
  blocks: [
    {
      type: 'toolCall',
      // `extractFilename` JSON-parses the context, so a bare path string here
      // yields no artifact at all — the fixture has to look like the wire.
      tool: { name: 'write_file', context: JSON.stringify({ path: 'C:/workspace/report.pdf' }), status: 'done' },
    },
  ],
} as unknown as ChatMessage;

const UPLOADED: ChatMessage = {
  id: 'm0',
  role: 'user',
  content: 'use these',
  timestamp: '2026-10-16T08:59:00.000Z',
  attachments: [
    { id: 'a1', name: 'template.docx', size: '9 KB', type: 'text', path: 'C:/uploads/template.docx', status: 'ready' },
    { id: 'a2', name: 'photo.png', size: '3 KB', type: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', status: 'ready' },
  ],
} as unknown as ChatMessage;

function mount() {
  streamRef.messages = [UPLOADED, PRODUCED];
  return render(<RightDrawerArtifactsSection sessionId="s1" />);
}

describe('RightDrawerArtifactsSection reference grouping', () => {
  beforeEach(() => {
    streamRef.messages = [];
  });

  it('offers one download action and does not repeat the tab strip title', () => {
    mount();
    // The drawer's tab strip already reads "Artifacts" (RightDrawer.tsx:313);
    // a heading in the body rendered the word twice, 20px apart. Measured in
    // the browser: the drawer read "Artifacts Artifacts No artifacts yet".
    expect(screen.queryByRole('heading', { name: 'Artifacts' })).toBeNull();
    expect(screen.getByTestId('download-all-artifacts')).toBeTruthy();
    // No per-row download: it resolves a filesystem path as a URL and never
    // saves anything, so offering it advertises a gesture that does not exist.
    expect(screen.queryAllByLabelText(/^Download /)).toEqual([]);
  });

  it('puts produced files in the top group and uploads under "Content"', () => {
    mount();
    const content = screen.getByRole('heading', { name: 'Content', level: 3 });
    const producedRow = screen.getByText('report.pdf').closest('div') as HTMLElement;
    // The produced row precedes the Content heading in document order.
    expect(producedRow.compareDocumentPosition(content)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('labels a produced PDF "Document · PDF", not a bare extension', () => {
    mount();
    expect(screen.getByText('Document · PDF')).toBeTruthy();
  });

  it('renders an uploaded image from its own data, not as a pathless file', () => {
    mount();
    // classifyFileKind on `data:image/png;base64,…` finds no extension and
    // answers "File", so a card that derived anything from `href` would label
    // every image that way. The image card shows the image.
    const card = screen.getByLabelText('Open photo.png in preview');
    const img = card.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(screen.queryByText('File')).toBeNull();
  });

  it('shows the uploaded files as cards and the cited link under "Links"', () => {
    mount();
    expect(screen.getByLabelText('Open template.docx in preview')).toBeTruthy();
    expect(screen.getByLabelText('Open photo.png in preview')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Links', level: 3 })).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
  });

  it('dropped the four kind-count pills that replaced grouping with tallies', () => {
    mount();
    const body = document.body.textContent || '';
    expect(body).not.toMatch(/Files · \d/);
    expect(body).not.toMatch(/Images · \d/);
    expect(body).not.toMatch(/All · \d/);
  });
});
