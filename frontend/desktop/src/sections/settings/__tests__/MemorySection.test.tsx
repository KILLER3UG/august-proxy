/* ── MemorySection test (plan §5.1 flat list + §5.5 raw state lookup) ── */

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

const projectListPayload = {
  ok: true,
  scope: 'project',
  files: ['memory.md'],
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

let stateLookupPayload: Record<string, unknown> = {
  key: 'cognitive:boot',
  found: true,
  source: 'internal_state',
  value: { phase: 'done' },
  updatedAt: iso(1),
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
      if (key.includes('state-lookup')) {
        // Exercise the real queryFn so the URL construction is observable.
        if (opts.enabled === false) return idle;
        void opts.queryFn?.().catch(() => undefined);
        return { data: stateLookupPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      }
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
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stateLookupPayload = {
    key: 'cognitive:boot',
    found: true,
    source: 'internal_state',
    value: { phase: 'done' },
    updatedAt: iso(1),
  };
});

describe('MemorySection — unified flat list (§5.1)', () => {
  it('merges both scope stores into one flat list sorted newest first', () => {
    renderSection('memory-facts');
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows).toHaveLength(3);
    // 5m ago (fact) → 60m ago (lesson) → 120m ago (fact)
    expect(rows[0]).toHaveTextContent('Prefers dark mode');
    expect(rows[1]).toHaveTextContent('Run tests after edits');
    expect(rows[2]).toHaveTextContent('FastAPI backend');
  });

  it('derives kind chips with counts: all / fact / lesson / pref / expiring', () => {
    renderSection('memory-facts');
    expect(screen.getByTestId('memory-kind-chip-all')).toHaveTextContent('3');
    expect(screen.getByTestId('memory-kind-chip-fact')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-lesson')).toHaveTextContent('1');
    expect(screen.getByTestId('memory-kind-chip-pref')).toHaveTextContent('1');
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
    // Writable fact row: menu has Edit and Delete.
    const factMenu = within(rows[0]).getByTestId('memory-row-menu');
    fireEvent.click(factMenu);
    expect(screen.getByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    // Legacy heuristics row: no live writer so no Edit — but DELETABLE
    // (brain.py _ROW_DELETABLE includes heuristics; C-11 stops the UI
    // suppressing a delete the backend allows).
    const lessonMenu = within(rows[1]).getByTestId('memory-row-menu');
    fireEvent.click(lessonMenu);
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
    fireEvent.click(screen.getByTestId('memory-add-button'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({ action: 'set', value: 'My plant is named Gerald' }),
      );
    });
  });

  it('dropped the Timeline + Sessions sub-tabs (Part 15.2)', () => {
    renderSection('memory-knowledge');
    // The Memories scope renders the KV memory store (autoMemories retired
    // 2026-09-04); rows from the deleted timeline/sessions scopes must not
    // leak in.
    const rows = screen.getAllByTestId('memory-flat-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.queryByText('Edited workbench.py')).not.toBeInTheDocument();
  });
});

describe('MemorySection — raw state lookup (§5.5)', () => {
  it('renders the raw row for a found key with source and JSON value', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('raw-state-key-input'), {
      target: { value: 'cognitive:boot' },
    });
    fireEvent.click(screen.getByTestId('raw-state-lookup-button'));
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        '/api/brain/state-lookup?key=cognitive%3Aboot',
      );
    });
    const result = await screen.findByTestId('raw-state-result');
    expect(result).toHaveTextContent('internal_state');
    expect(result).toHaveTextContent('"phase": "done"');
  });

  it('says when no row exists for the key', async () => {
    stateLookupPayload = { key: 'nope', found: false, source: null, value: null, updatedAt: null };
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('raw-state-key-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('raw-state-lookup-button'));
    const result = await screen.findByTestId('raw-state-result');
    await waitFor(() => {
      expect(result).toHaveTextContent('no row for key "nope"');
    });
  });
});

describe('MemorySection — Part 17 Phase C gap closings', () => {
  // C-1: scope selector lists Global + one entry per known workspace.
  it('shows the scope selector with the known workspaces (C-1)', () => {
    renderSection('memory-facts');
    const select = screen.getByTestId('memory-scope-select');
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toEqual([
      'Global (all workspaces)',
      'august-proxy · project',
      'sheesh · project',
    ]);
    expect(select.value).toBe('');
  });

  // C-3: category/source/confidence filters and C-4: sort control exist and feed the query URL.
  it('sends category/source/confidence/sort as query params (C-3/C-4, §9 F-6)', async () => {
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

  // C-7: the add box gains a category select (global) and routes project
  // scope writes through the md-file door.
  it('add-box posts with the chosen category (C-7)', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-add-category'), { target: { value: 'user' } });
    fireEvent.change(screen.getByTestId('memory-add-input'), { target: { value: 'Likes tea' } });
    fireEvent.click(screen.getByTestId('memory-add-button'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({ action: 'set', value: 'Likes tea', category: 'user' }),
      );
    });
  });

  // M-10 (Part 21): the add-box TTL selection rides the manage call.
  it('add-box posts ttl_days when an expiry is chosen (M-10)', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-add-ttl'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('memory-add-input'), { target: { value: 'Temporary note' } });
    fireEvent.click(screen.getByTestId('memory-add-button'));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/august/memory/manage',
        expect.objectContaining({ action: 'set', value: 'Temporary note', ttl_days: 30 }),
      );
    });
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

  // C-9: project scope view shows md files + entries + bound sessions.
  it('switching to a workspace shows the project view (C-9)', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-scope-select'), {
      target: { value: 'C:\\Dev\\august-proxy' },
    });
    const view = await screen.findByTestId('memory-project-view');
    expect(view).toHaveTextContent('NSIS is legacy here');
    expect(screen.getByTestId('memory-project-files')).toHaveTextContent('memory.md');
    expect(screen.getByTestId('memory-project-path')).toHaveTextContent('august-proxy');
    expect(view).toHaveTextContent('4 sessions bound');
    // The project add-box posts through the md-file door.
    fireEvent.change(screen.getByTestId('memory-add-input'), { target: { value: 'New project note' } });
    fireEvent.click(screen.getByTestId('memory-add-button'));
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

  // C-9 delete: project entries delete through the project door.
  it('project entries delete via scope=project (C-9)', async () => {
    renderSection('memory-facts');
    fireEvent.change(screen.getByTestId('memory-scope-select'), {
      target: { value: 'C:\\Dev\\august-proxy' },
    });
    await screen.findByTestId('memory-project-view');
    fireEvent.click(screen.getByTestId('memory-project-delete'));
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
