/* ── MemorySection: the Claude-shaped pane, not a stack of boxes ─────── */
/* The complaint this pins down: the Memory page read as many nested cards with
 * wide gaps, and the list itself was a click deep behind an "All global
 * memories" row — so the page whose whole job is showing what August remembers
 * opened with a row ABOUT the list instead of the list. It is now one column of
 * hairline-separated rows under named section headings, and opening a memory, a
 * project or a file replaces the whole content column. So the load-bearing
 * assertions are (a) the rows are the page, (b) no card chrome around the
 * groups, and (c) what is NOT in the DOM once a pane opens. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));
vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/api/client';
import { MemorySection } from '../MemorySection';

const getMock = vi.mocked(api.get);
const postMock = vi.mocked(api.post);
const putMock = vi.mocked(api.put);

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  postMock.mockResolvedValue({
    ok: true,
    scope: 'project',
    files: [{ file: 'memory.md', entries: 1, updated: iso(30) }],
    entries: [
      {
        key: 'project:NSIS is legacy here',
        title: 'NSIS is legacy here',
        body: 'NSIS is legacy here',
        updated: iso(30),
        file: 'memory.md',
      },
    ],
  });
  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/brain/stores/facts')) {
      return {
        store: 'facts',
        rows: [
          {
            id: 1,
            factKey: 'user:editor',
            factValue: 'Prefers dark mode',
            kind: 'fact',
            category: 'user',
            source: 'remember',
            updatedAt: iso(5),
          },
        ],
        total: 1,
        limit: 200,
        offset: 0,
      };
    }
    if (url.startsWith('/api/brain/stores/')) {
      return { store: 'x', rows: [], total: 0, limit: 200, offset: 0 };
    }
    if (url.startsWith('/api/brain/stores')) return { stores: [] };
    if (url.startsWith('/api/brain/config')) return { config: {} };
    if (url.startsWith('/api/brain/consolidation/log')) return { entries: [] };
    if (url.startsWith('/api/august/memory/workspaces')) {
      return {
        workspaces: [
          { path: 'C:\\Dev\\blog', name: 'blog', hasMemory: true, hasSkills: false, sessions: 2 },
        ],
      };
    }
    if (url.startsWith('/api/brain/memory/preview')) {
      return {
        query: '',
        workspace: '',
        autoInject: false,
        modelMemoryRead: true,
        turnBlock: '',
        bootIndex: '',
        projectBlock: '',
        injectedFacts: [],
      };
    }
    if (url.startsWith('/api/brain/integrity')) return { ok: true, exists: true };
    if (url.startsWith('/api/brain/backups')) return { backups: [] };
    return {};
  });
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id: 'memory-knowledge' }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MemorySection — the rows are the page', () => {
  it('renders the entries themselves, with no click-through row in front of them', async () => {
    renderPage();
    // The old page opened with one row per store that you had to click to see
    // anything. That row is gone; the entries paint immediately.
    expect(screen.queryByTestId('memory-global-row')).toBeNull();
    const rows = await screen.findAllByTestId('memory-flat-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Prefers dark mode');
    // Grouped under a named section rather than stamped with a per-row chip.
    expect(within(screen.getByTestId('memory-section-topics')).getByTestId('memory-flat-row')).toBe(
      rows[0],
    );
  });

  it('opens the import door from a banner above the list', async () => {
    renderPage();
    const banner = await screen.findByTestId('memory-import-banner');
    expect(banner).toHaveTextContent('Import memory from other AI providers');
    expect(within(banner).getByTestId('memory-import-open')).toBeInTheDocument();
  });

  it('keeps the behaviour gates below the entries they describe', async () => {
    renderPage();
    await screen.findByTestId('memory-section-topics');
    const order = [...document.querySelectorAll('[data-testid]')].map((e) =>
      e.getAttribute('data-testid'),
    );
    // The content comes before the prose about the content's switches.
    expect(order.indexOf('memory-section-topics')).toBeLessThan(
      order.indexOf('memory-group-behavior'),
    );
    expect(order.indexOf('memory-group-behavior')).toBeLessThan(
      order.indexOf('memory-group-project'),
    );
  });

  it('dropped the card chrome the groups used to each sit inside', async () => {
    renderPage();
    await screen.findByTestId('memory-group-project');
    // No collapsible cards anywhere in the memory groups.
    for (const id of ['memory-group-behavior', 'memory-group-project']) {
      expect(within(screen.getByTestId(id)).queryByTestId(/-card-header$/)).toBeNull();
    }
    // Groups are rules, not rounded boxes.
    expect(screen.getByTestId('memory-group-project').className).toContain('border-t');
  });

  it('adds from one pinned input at the bottom of the pane', async () => {
    renderPage();
    const bar = await screen.findByTestId('memory-add');
    expect(within(bar).getByTestId('memory-add-input')).toBeInTheDocument();
    // Category and expiry are per-entry edits, not part of every write.
    expect(screen.queryByTestId('memory-add-category')).toBeNull();
    expect(screen.queryByTestId('memory-add-ttl')).toBeNull();
  });
});

describe('MemorySection — a pane replaces the column', () => {
  it('opening a project removes the list pane from the DOM', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-project-row'));

    const pane = await screen.findByTestId('memory-project-pane');
    // The pane paints its own loading state before the folder read lands.
    expect(await within(pane).findByTestId('memory-project-file')).toHaveTextContent('memory.md');
    expect(screen.queryByTestId('memory-section-topics')).toBeNull();
    expect(screen.queryByTestId('memory-group-project')).toBeNull();
    expect(screen.queryByTestId('memory-flat-row')).toBeNull();
  });

  it('back from the file pane lands on the project, then on the list', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-project-row'));
    const pane = await screen.findByTestId('memory-project-pane');
    fireEvent.click(await within(pane).findByTestId('memory-project-file'));

    const filePane = await screen.findByTestId('memory-file-pane');
    expect(within(filePane).getByTestId('memory-file-pane-header')).toHaveTextContent('memory.md');
    // The read goes through the same door that listed the file.
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({ action: 'read', key: 'memory.md' }),
      ),
    );

    fireEvent.click(within(filePane).getByTestId('memory-file-pane-header-back'));
    await waitFor(() => expect(screen.getByTestId('memory-project-pane')).toBeInTheDocument());
    expect(screen.queryByTestId('memory-file-pane')).toBeNull();

    fireEvent.click(screen.getByTestId('memory-project-pane-header-back'));
    await waitFor(() => expect(screen.getByTestId('memory-group-project')).toBeInTheDocument());
  });

  it('opening a memory row fills the column with its detail', async () => {
    renderPage();
    // One click on the row — the ⋯ menu that used to gate "View" is gone.
    fireEvent.click(await screen.findByTestId('memory-row-open'));
    await waitFor(() => expect(screen.getByTestId('memory-detail-view')).toBeInTheDocument());
    expect(screen.queryByTestId('memory-flat-row')).toBeNull();
    // The detail replaces the whole column (gates included) — that state is
    // the entry, not the browser. Browsing panes keep the gates visible.
    expect(screen.queryByTestId('memory-group-behavior')).toBeNull();
  });

  /* The pane is named by what the entry says, not by its store key — the key
   * is what the model quotes (`forget(key=…)`), which a reader has nothing to
   * match against. It stays on the line below, quotable but not the label. */
  it('names the pane by the memory’s text and keeps the key underneath', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-row-open'));
    const detail = await screen.findByTestId('memory-detail-view');
    expect(within(detail).getByRole('heading', { level: 2 })).toHaveTextContent('Prefers dark mode');
    expect(within(detail).getByTestId('memory-detail-key')).toHaveTextContent('user:editor');
    // And it does not echo that sentence back underneath itself: a plain
    // fact's title is its whole text, so a second copy is noise.
    expect(within(detail).getAllByText(/Prefers dark mode/)).toHaveLength(1);
  });
});

/* The conversation-review switch. It is the only door that lets August write a
 * memory nobody asked for, so two things must be true on this surface: an
 * absent config key renders OFF (not "unknown", not on), and the label that
 * search finds is the label the page actually says. */
describe('MemorySection — learn-from-conversations switch', () => {
  it('is off when the server sends no memoryReview key', async () => {
    renderPage();
    const sw = await screen.findByTestId('memory-review-toggle');
    expect(sw).toHaveAttribute('role', 'switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('reflects an armed switch and PUTs only the key it owns', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/brain/config')) return Promise.resolve({ config: { memoryReview: true } });
      if (url.startsWith('/api/brain/stores/')) {
        return Promise.resolve({ store: 'x', rows: [], total: 0, limit: 200, offset: 0 });
      }
      if (url.startsWith('/api/brain/stores')) return Promise.resolve({ stores: [] });
      if (url.startsWith('/api/brain/consolidation/log')) return Promise.resolve({ entries: [] });
      if (url.startsWith('/api/august/memory/workspaces')) return Promise.resolve({ workspaces: [] });
      if (url.startsWith('/api/brain/integrity')) return Promise.resolve({ ok: true, exists: true });
      if (url.startsWith('/api/brain/backups')) return Promise.resolve({ backups: [] });
      return Promise.resolve({});
    });
    putMock.mockResolvedValue({});
    renderPage();
    const sw = await screen.findByTestId('memory-review-toggle');
    // The row renders before the config query resolves, so await the state the
    // server sent rather than the first paint.
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/brain/config', { memoryReview: false }),
    );
  });
});
