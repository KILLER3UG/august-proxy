/* ── MemorySection: the Claude-shaped pane, not a stack of boxes ─────── */
/* The complaint this pins down: the Memory page read as many nested cards with
 * wide gaps, and opening something swapped a region inside the list. It is now
 * one column of hairline-separated rows under small group labels, and opening a
 * memory, a project or a file replaces the whole content column. So the
 * load-bearing assertions are (a) no card chrome around the groups, and (b) what
 * is NOT in the DOM once a pane opens. */

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

describe('MemorySection — one column of rows', () => {
  it('leads with one line per store and opens Global memory on click', async () => {
    renderPage();
    await screen.findByTestId('memory-group-global');
    for (const id of [
      'memory-group-behavior',
      'memory-group-global',
      'memory-group-project',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // Nothing is browsable yet: the rows live behind the Global memory row.
    expect(screen.queryByTestId('memory-flat-row')).toBeNull();
    fireEvent.click(screen.getByTestId('memory-global-row'));
    expect(await screen.findByTestId('memory-flat-row')).toHaveTextContent('Prefers dark mode');
    expect(screen.getByTestId('memory-global-pane-header')).toBeInTheDocument();
    expect(screen.queryByTestId('memory-group-behavior')).toBeNull();
  });

  it('dropped the card chrome the groups used to each sit inside', async () => {
    renderPage();
    await screen.findByTestId('memory-group-global');
    // No collapsible cards anywhere in the memory groups.
    for (const id of ['memory-group-behavior', 'memory-group-global', 'memory-group-project']) {
      expect(within(screen.getByTestId(id)).queryByTestId(/-card-header$/)).toBeNull();
    }
    // Groups are rules, not rounded boxes.
    expect(screen.getByTestId('memory-group-global').className).toContain('border-t');
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
    await screen.findByTestId('memory-project-row');
    fireEvent.click(screen.getByTestId('memory-project-row'));

    const pane = await screen.findByTestId('memory-project-pane');
    // The pane paints its own loading state before the folder read lands.
    expect(await within(pane).findByTestId('memory-project-file')).toHaveTextContent('memory.md');
    expect(screen.queryByTestId('memory-group-global')).toBeNull();
    expect(screen.queryByTestId('memory-group-project')).toBeNull();
    expect(screen.queryByTestId('memory-flat-list')).toBeNull();
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
    fireEvent.click(await screen.findByTestId('memory-global-row'));
    const row = await screen.findByTestId('memory-flat-row');
    fireEvent.click(within(row).getByTestId('memory-row-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /view/i }));
    await waitFor(() => expect(screen.getByTestId('memory-detail-view')).toBeInTheDocument());
    expect(screen.queryByTestId('memory-flat-list')).toBeNull();
    expect(screen.queryByTestId('memory-group-behavior')).toBeNull();
  });

  /* The pane is named by what the entry says, not by its store key — the key
   * is what the model quotes (`forget(key=…)`), which a reader has nothing to
   * match against. It stays on the line below, quotable but not the label. */
  it('names the pane by the memory’s text and keeps the key underneath', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-global-row'));
    const row = await screen.findByTestId('memory-flat-row');
    fireEvent.click(within(row).getByTestId('memory-row-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /view/i }));
    const detail = await screen.findByTestId('memory-detail-view');
    expect(within(detail).getByRole('heading', { level: 2 })).toHaveTextContent('Prefers dark mode');
    expect(within(detail).getByTestId('memory-detail-key')).toHaveTextContent('user:editor');
    // And it does not echo that sentence back underneath itself: a plain
    // fact's title is its whole text, so a second copy is noise.
    expect(within(detail).getAllByText(/Prefers dark mode/)).toHaveLength(1);
  });
});
