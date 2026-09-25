/* ── MemorySection test ── */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
// Dynamic expiry: an absolute date silently flipped from "expiring soon" to
// "expired" when the calendar rolled past it (found live 2026-09-02) — keep
// every expiry relative to the run time.
const isoInDays = (days: number) =>
  new Date(now + days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
/* SQLite's datetime('now') — UTC, but with no zone marker. Read as local time
 * it shifts by the machine's offset, so on a UTC+8 box a fact learned two
 * minutes ago rendered "8h ago" and an expiry arrived eight hours early. This
 * shape is what the store wire actually sends. (On a UTC machine the shift is
 * zero and this test is vacuous — it exists to catch the bug where it bites.) */
const sqliteUtc = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);

/* Fixture rows per store, in the camelCase WIRE shape the real
 * /api/brain/stores/{name} endpoint returns (rows pass through the backend
 * `_row_as_wire` snake→camel converter). facts: one user-category (→ pref)
 * with expiry, one project-category (→ fact). heuristics: one lesson (legacy).
 * memory: one KV note. (autoMemories retired 2026-09-04, Part 21 OQ1 — no
 * longer a store the Memories scope renders.) */
const rowsByStore: Record<string, { rows: Array<Record<string, unknown>>; total: number }> = {
  facts: {
    rows: [
      {
        id: 1,
        factKey: 'user:editor',
        factValue: JSON.stringify({ fact: 'Prefers dark mode' }),
        category: 'user',
        source: 'remember',
        updatedAt: iso(5),
      },
      {
        id: 2,
        factKey: 'project:stack',
        factValue: 'FastAPI backend',
        category: 'project',
        source: 'extracted',
        updatedAt: iso(120),
        expiresAt: isoInDays(7),
      },
    ],
    total: 2,
  },
  heuristics: {
    rows: [
      { id: 9, rule: 'Run tests after edits', source: 'lesson', category: 'workflow', updatedAt: iso(60) },
    ],
    total: 1,
  },
  memory: {
    rows: [{ key: 'user:plant', value: 'My plant is named Gerald', updatedAt: iso(10) }],
    total: 1,
  },
  timeline: {
    rows: [{ id: 7, eventSummary: 'Edited workbench.py', sessionId: 'sess_1', category: 'edit', timestamp: iso(2) }],
    total: 1,
  },
  blackboard: { rows: [], total: 0 },
  sessions: { rows: [], total: 0 },
  messages: { rows: [], total: 0 },
  exams: { rows: [], total: 0 },
  examAttempts: { rows: [], total: 0 },
};

const storesPayload = {
  stores: Object.entries(rowsByStore).map(([name, p]) => ({
    name,
    label: name,
    count: p.total,
  })),
};

const consolidationLog = {
  entries: [
    { createdAt: iso(45), eventType: 'lesson_promoted', detail: {} },
    { createdAt: iso(180), eventType: 'consolidation', detail: { expired: 3, merged: 1 } },
  ],
};

const workspacesPayload = {
  workspaces: [
    { path: 'C:\\Dev\\august-proxy', name: 'august-proxy', hasMemory: true, hasSkills: false, sessions: 4 },
    { path: 'C:\\Dev\\sheesh', name: 'sheesh', hasMemory: false, hasSkills: true, sessions: 1 },
  ],
};

/* The REAL wire shape of project_memory.list_files(): one object per file with
 * its entry count, not a bare filename. An earlier fixture here said
 * `files: ['memory.md']`, which matched the frontend's wrong `string[]` type and
 * let the "Objects are not valid as a React child" crash ship. */
const projectListPayload = {
  ok: true,
  scope: 'project',
  files: [
    { file: 'memory.md', entries: 1, updated: iso(30) },
    { file: 'user-profile.md', entries: 2, updated: iso(90) },
  ],
  entries: [
    {
      key: 'project:NSIS is legacy here',
      title: 'NSIS is legacy here',
      body: 'NSIS is legacy here\n\nUse WiX for installers.',
      updated: iso(30),
      file: 'memory.md',
    },
  ],
};

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  type QOpts = { queryKey?: unknown; enabled?: boolean; queryFn?: () => Promise<unknown> };
  const idle = { data: null, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
  return {
    ...actual,
    useQuery: (opts: QOpts) => {
      const key = JSON.stringify(opts.queryKey ?? []);
      if (key.includes('brain-stores'))
        return { data: storesPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      if (key.includes('brain-config'))
        return {
          data: { config: { modelMemoryWrites: true, memorySensitiveTopics: false } },
          isLoading: false,
          isError: false,
          isFetching: false,
          refetch: vi.fn(),
        };
      if (key.includes('consolidation-log'))
        return { data: consolidationLog, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      if (key.includes('memory-workspaces'))
        return { data: workspacesPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      if (key.includes('project-memory'))
        return { data: projectListPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      if (key.includes('brain-store')) {
        // Exercise the real queryFn so URL construction (filters, sort,
        // offset — Part 17 C-3/4/5) is observable through the api.get mock.
        if (opts.enabled === false) return idle;
        void opts.queryFn?.().catch(() => undefined);
        for (const [name, page] of Object.entries(rowsByStore)) {
          if (key.includes(JSON.stringify(name))) {
            return {
              data: { store: name, rows: page.rows, total: page.total, limit: 200, offset: 0 },
              isLoading: false,
              isError: false,
              isFetching: false,
              refetch: vi.fn(),
            };
          }
        }
      }
      return { data: null, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({ ok: true })),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ row: {} })),
    delete: vi.fn(async () => ({})),
  },
}));

import { MemorySection } from '../MemorySection';
import { api } from '@/api/client';

function renderSection(id = 'memory-facts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Global memory is a row that opens its own pane; these tests are about the
  // browse inside it.
  fireEvent.click(screen.getByTestId('memory-global-row'));
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemorySection — unified flat list', () => {
  /* The Global memory group is one list across every browsable store — facts,
   * KV notes and the legacy heuristics table — because the choice between
   * "Memories" and "Facts & Rules" was a choice between two backend tables. */
  it('merges every global store into one flat list sorted newest first', () => {
    renderSection('memory-facts');
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows).toHaveLength(4);
    // 5m fact → 10m KV note → 60m lesson → 120m fact
    expect(rows[0]).toHaveTextContent('Prefers dark mode');
    expect(rows[1]).toHaveTextContent('My plant is named Gerald');
    expect(rows[2]).toHaveTextContent('Run tests after edits');
    expect(rows[3]).toHaveTextContent('FastAPI backend');
  });

  it('renders the same list for either deep-link alias', () => {
    const facts = renderSection('memory-facts');
    const count = screen.getAllByTestId('memory-flat-row').length;
    facts.unmount();
    renderSection('memory-knowledge');
    expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(count);
    expect(screen.getByRole('heading', { name: 'Memory' })).toBeInTheDocument();
  });

  it('derives kind chips with counts: all / fact / lesson / pref / note / expiring', () => {
    renderSection('memory-facts');
    expect(screen.getByTestId('memory-kind-chip-all')).toHaveTextContent('4');
    expect(screen.getByTestId('memory-kind-chip-fact')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-lesson')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-pref')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-note')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-expiring')).toHaveTextContent('1');
  });

  it('filters to lessons when the lesson chip is clicked', () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-kind-chip-lesson'));
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Run tests after edits');
    expect(rows[0]).toHaveAttribute('data-kind', 'lesson');
  });

  it('filters to rows with an expiry when the expiring chip is clicked', () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-kind-chip-expiring'));
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('FastAPI backend');
  });

  it('offers Edit + Delete for writable rows; legacy heuristics get Delete but not Edit (C-11)', () => {
    renderSection('memory-facts');
    const rows = screen.getAllByTestId('memory-flat-row');
    // Located by kind, not index: the merged list orders by recency across
    // three stores, so a position is not a stable way to name a row.
    const rowOf = (kind: string) => rows.find((r) => r.getAttribute('data-kind') === kind)!;
    // Writable fact row: menu has Edit and Delete.
    fireEvent.click(within(rowOf('fact')).getByTestId('memory-row-menu'));
    expect(screen.getByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    // Legacy heuristics row: no live writer so no Edit — but DELETABLE
    // (brain.py _ROW_DELETABLE includes heuristics; C-11 stops the UI
    // suppressing a delete the backend allows).
    fireEvent.click(within(rowOf('lesson')).getByTestId('memory-row-menu'));
    expect(screen.queryByRole('menuitem', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /view/i })).toBeInTheDocument();
  });

  it('shows the health footer with last consolidation counts and runs one on demand', async () => {
    renderSection('memory-facts');
    const footer = screen.getByTestId('memory-health-footer');
    expect(footer).toHaveTextContent('expired · 3 · duplicates merged · 1');
    expect(footer).toHaveTextContent('last consolidation');
    fireEvent.click(screen.getByTestId('memory-consolidate-now'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/brain/consolidation/run', {});
    });
  });

  it('add-box posts to /api/august/memory/manage (not the old 404 path)', async () => {
    renderSection('memory-knowledge');
    fireEvent.change(screen.getByTestId('memory-add-input'), {
      target: { value: 'My plant is named Gerald' },
    });
    fireEvent.click(screen.getByTestId('memory-add-submit'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({ action: 'set', value: 'My plant is named Gerald' }),
      );
    });
  });

  it('dropped the Timeline + Sessions sub-tabs', () => {
    renderSection('memory-knowledge');
    // The Memories scope renders the KV memory store (autoMemories retired
    // 2026-09-04); rows from the deleted timeline/sessions scopes must not
    // leak in.
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.queryByText('Edited workbench.py')).not.toBeInTheDocument();
  });
});

describe('MemorySection — Part 17 Phase C gap closings', () => {
  // C-1: every workspace that holds a memory folder gets its own row, so the
  // page says what exists without anyone opening a picker. `sheesh` has skills
  // but no memory folder, so it is not a memory row.
  it('renders one row per project that has memory (C-1)', () => {
    renderSection('memory-facts');
    const group = screen.getByTestId('memory-group-project');
    const rows = within(group).getAllByTestId('memory-project-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('august-proxy');
    expect(within(group).queryByText('sheesh')).toBeNull();
    // The folder's contents are not on this pane — the row opens them.
    expect(within(group).queryByTestId('memory-project-files')).toBeNull();
  });

  // C-3: category/source/confidence filters and C-4: sort control exist and feed the query URL.
  it('sends category/source/confidence/sort as query params', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-category-filter'), { target: { value: 'user' } });
    fireEvent.change(screen.getByTestId('memory-source-filter'), { target: { value: 'remember' } });
    fireEvent.change(screen.getByTestId('memory-confidence-filter'), { target: { value: 'high' } });
    fireEvent.change(screen.getByTestId('memory-sort'), { target: { value: 'updated' } });
    await waitFor(() => {
      const urls = (api.get as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes('/api/brain/stores/facts'));
      const factFetch = urls[urls.length - 1];
      expect(factFetch).toBeTruthy();
      expect(factFetch).toContain('sort=updated');
      expect(factFetch).toContain('category=user');
      expect(factFetch).toContain('source=remember');
      expect(factFetch).toContain('confidence=high');
    });
  });

  // C-2: source badges render on rows that carry one.
  it('shows a source badge on rows with a source (C-2)', () => {
    renderSection('memory-facts');
    const badges = screen.getAllByTestId('memory-source-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((b) => b.textContent === 'remember')).toBe(true);
  });

  /* Category and expiry are per-entry edits now — the bottom bar is one field,
   * so they moved into the row's edit view (both are in the facts whitelist the
   * backend PATCH accepts). */
  it('sets category and expiry from the row’s edit view (C-7, M-10)', async () => {
    renderSection('memory-facts');
    const rows = screen.getAllByTestId('memory-flat-row');
    fireEvent.click(within(rows[0]).getByTestId('memory-row-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /edit/i }));

    fireEvent.change(screen.getByLabelText('category'), { target: { value: 'user' } });
    fireEvent.change(screen.getByLabelText('expires_at'), {
      target: { value: '2026-12-31 00:00:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/brain/stores/facts/1',
        expect.objectContaining({ category: 'user', 'expires_at': '2026-12-31 00:00:00' }),
      ),
    );
  });

  // C-8: expired rows are visually separated with an absolute date.
  it('badges expired rows with the absolute expiry date, dimmed (C-8)', () => {
    renderSection('memory-facts');
    // The project:stack fixture expires 7 days from NOW (dynamic — an
    // absolute date silently flipped from "expiring soon" to "expired" when
    // the calendar rolled past it) — it must render as "expiring", not
    // expired.
    expect(screen.getByTestId('memory-expiring-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('memory-expired-badge')).not.toBeInTheDocument();
  });

  it('reads a store timestamp as UTC, not as local time', () => {
    const original = rowsByStore.facts.rows;
    const originalTotal = rowsByStore.facts.total;
    rowsByStore.facts.rows = [
      { id: 50, factKey: 'user:fresh', factValue: 'Learned just now', kind: 'fact', updatedAt: sqliteUtc(2) },
      // An expiry one hour AHEAD, in the same markerless UTC shape.
      { id: 51, factKey: 'user:soon', factValue: 'Expires in an hour', kind: 'fact', updatedAt: sqliteUtc(3), expiresAt: sqliteUtc(-60) },
    ];
    rowsByStore.facts.total = 2;
    try {
      renderSection('memory-facts');
      const rows = screen.getAllByTestId('memory-flat-row');
      // Two minutes, not "8h ago" — the shift was the machine's UTC offset.
      expect(rows[0]).toHaveTextContent('Learned just now');
      expect(rows[0]).toHaveTextContent('2m ago');
      // And a future expiry must not be filed as expired.
      expect(screen.queryByTestId('memory-expired-badge')).toBeNull();
      expect(screen.getByTestId('memory-expiring-badge')).toBeInTheDocument();
    } finally {
      rowsByStore.facts.rows = original;
      rowsByStore.facts.total = originalTotal;
    }
  });

  // C-6: bulk select + bulk delete + bulk export.
  it('bulk-select enables Delete selected + Export selected (C-6)', async () => {
    renderSection('memory-facts');
    const checks = screen.getAllByTestId('memory-bulk-check');
    fireEvent.click(checks[0]);
    fireEvent.click(checks[2]);
    expect(screen.getByTestId('memory-bulk-count')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('memory-bulk-delete')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-bulk-delete'));
    // The ConfirmDialog resolves via useConfirmDialog; api.delete per row.
    await waitFor(() => {
      expect(screen.getByText('Delete 2 entries?')).toBeInTheDocument();
    });
  });

  // C-9: picking a workspace shows its md files + entries + bound sessions —
  // alongside the global list, which switching scope used to hide.
  it('opening a project replaces the pane with its files and entries (C-9)', async () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-project-row'));

    const pane = await screen.findByTestId('memory-project-pane');
    // The Files roster renders the server's {file, entries, updated} objects —
    // the shape that used to throw "Objects are not valid as a React child".
    const files = within(pane).getByTestId('memory-project-files');
    const rows = within(files).getAllByTestId('memory-project-file');
    expect(rows).toHaveLength(2);
    expect(within(files).getByText('memory.md')).toBeInTheDocument();
    expect(within(rows[0]).getByText('1 entry')).toBeInTheDocument();
    expect(within(rows[1]).getByText('2 entries')).toBeInTheDocument();
    expect(within(pane).getByTestId('memory-project-entries')).toHaveTextContent(
      'NSIS is legacy here',
    );
    // A pane switch, not a region swap: the global list is gone from the DOM.
    expect(screen.queryByTestId('memory-group-global')).toBeNull();
    expect(screen.queryByTestId('memory-flat-list')).toBeNull();

    // The pane's own bar posts through the md-file door.
    fireEvent.change(within(pane).getByTestId('memory-project-add-input'), {
      target: { value: 'New project note' },
    });
    fireEvent.click(within(pane).getByTestId('memory-project-add-submit'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({
          action: 'set',
          scope: 'project',
          workspace: 'C:\\Dev\\august-proxy',
          value: 'New project note',
        }),
      );
    });
  });

  it('back from a project returns to the memory list', async () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-project-row'));
    const pane = await screen.findByTestId('memory-project-pane');
    fireEvent.click(within(pane).getByTestId('memory-project-pane-header-back'));
    await waitFor(() => expect(screen.getByTestId('memory-group-global')).toBeInTheDocument());
    expect(screen.queryByTestId('memory-project-pane')).toBeNull();
  });

  it('opening a memory file swaps the column to its pane', async () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-project-row'));
    const pane = await screen.findByTestId('memory-project-pane');
    const [firstFile] = await within(pane).findAllByTestId('memory-project-file');
    fireEvent.click(firstFile);

    // This file mocks useQuery wholesale, so the read request itself is asserted
    // in MemorySection.layout.test.tsx; here it is the routing that matters.
    const filePane = await screen.findByTestId('memory-file-pane');
    expect(within(filePane).getByTestId('memory-file-pane-header')).toHaveTextContent('memory.md');
    expect(screen.queryByTestId('memory-project-pane')).toBeNull();
    // Back leads to the project it came from, not to the top of the page.
    fireEvent.click(within(filePane).getByTestId('memory-file-pane-header-back'));
    await waitFor(() => expect(screen.getByTestId('memory-project-pane')).toBeInTheDocument());
  });

  it('adds a global memory as a fact, the store recall reads', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-add-input'), {
      target: { value: 'My coffee machine is called Brev' },
    });
    fireEvent.click(screen.getByTestId('memory-add-submit'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({
          action: 'set',
          key: 'user:my-coffee-machine-is-called-brev',
          value: 'My coffee machine is called Brev',
          source: 'user',
        }),
      );
    });
    // No project selected: nothing rides along to the md-file door.
    expect(api.post).not.toHaveBeenCalledWith(
      '/api/august/memory/manage',
      expect.objectContaining({ scope: 'project' }),
    );
  });

  // C-9 delete: project entries delete through the project door.
  it('project entries delete via scope=project (C-9)', async () => {
    renderSection('memory-facts');
    fireEvent.click(screen.getByTestId('memory-project-row'));
    const pane = await screen.findByTestId('memory-project-pane');
    await within(pane).findByTestId('memory-project-entries');
    fireEvent.click(within(pane).getByTestId('memory-project-delete'));
    await waitFor(() => {
      expect(screen.getByText('Delete this project entry?')).toBeInTheDocument();
    });
  });

  // C-5: pager renders when totals exceed the 200-row fetch cap.
  it('shows the unified pager past 200 rows (C-5)', () => {
    // rowsByStore totals are small (2/1) — the pager stays hidden; assert
    // the hidden state so the visible branch is anchored too.
    renderSection('memory-facts');
    expect(screen.queryByTestId('memory-unified-pager')).not.toBeInTheDocument();
  });
});
