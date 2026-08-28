/* ── MemorySection test (plan §5.1 flat list + §5.5 raw state lookup) ── */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

/* Fixture rows per store. facts: one user-category (→ pref) with expiry,
 * one project-category (→ fact). heuristics: one lesson (legacy). memory:
 * one KV note. autoMemories: one legacy note. */
const rowsByStore: Record<string, { rows: Array<Record<string, unknown>>; total: number }> = {
  facts: {
    rows: [
      {
        id: 1,
        fact_key: 'user:editor',
        fact_value: JSON.stringify({ fact: 'Prefers dark mode' }),
        category: 'user',
        source: 'remember',
        updated_at: iso(5),
      },
      {
        id: 2,
        fact_key: 'project:stack',
        fact_value: 'FastAPI backend',
        category: 'project',
        source: 'extracted',
        updated_at: iso(120),
        expires_at: '2026-09-01 00:00:00',
      },
    ],
    total: 2,
  },
  heuristics: {
    rows: [
      { id: 9, rule: 'Run tests after edits', source: 'lesson', category: 'workflow', updated_at: iso(60) },
    ],
    total: 1,
  },
  memory: {
    rows: [{ key: 'user:plant', value: 'My plant is named Gerald', updated_at: iso(10) }],
    total: 1,
  },
  autoMemories: {
    rows: [{ id: 5, key: 'auto:note', content: 'Legacy note', category: 'general', created_at: iso(300) }],
    total: 1,
  },
  timeline: {
    rows: [{ id: 7, event_summary: 'Edited workbench.py', session_id: 'sess_1', category: 'edit', timestamp: iso(2) }],
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
      if (key.includes('state-lookup')) {
        // Exercise the real queryFn so the URL construction is observable.
        if (opts.enabled === false) return idle;
        void opts.queryFn?.().catch(() => undefined);
        return { data: stateLookupPayload, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
      }
      if (key.includes('brain-store')) {
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

  it('offers Edit + Delete for writable rows but not for legacy rows', () => {
    renderSection('memory-facts');
    const rows = screen.getAllByTestId('memory-flat-row');
    // Writable fact row: menu has Edit and Delete.
    const factMenu = within(rows[0]).getByTestId('memory-row-menu');
    fireEvent.click(factMenu);
    expect(screen.getByRole('menuitem', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    // Legacy heuristics row: read-only — no Edit, no Delete.
    const lessonMenu = within(rows[1]).getByTestId('memory-row-menu');
    fireEvent.click(lessonMenu);
    expect(screen.queryByRole('menuitem', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
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
    // The Memories scope merges only autoMemories + memory into the flat
    // list; rows from the deleted timeline/sessions scopes must not leak in.
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
