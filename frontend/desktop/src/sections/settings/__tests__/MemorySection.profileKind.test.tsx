/* ── MemorySection: the profile lane is visible and correctable ──────── */
/* `kind='profile'` facts are the always-in-context lane the backend injects on
 * every turn (services/memory_store/fact_retrieval.py), so the browse UI must
 * read the row's real `kind` column — not re-derive it from category — and let
 * you move a row in or out.
 *
 * The second half matters as much as the first: the lane action PATCHes and
 * then waits. A locally flipped chip would tell you a fact is riding along on
 * every turn when the server never accepted it. These tests pin both the write
 * AND that the label only changes once the refetched row says so. */

import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, configure } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

configure({ asyncUtilTimeout: 5000 });

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { MemorySection } from '../MemorySection';

const getMock = vi.mocked(api.get);
const patchMock = vi.mocked(api.patch);

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

type FactRow = Record<string, unknown>;

/* Mutable: a PATCH's invalidation re-reads this, which is how a test can tell
 * "server confirmed" apart from "component guessed". */
let factRows: FactRow[];

function seedFacts() {
  factRows = [
    // category 'project' would derive 'fact' — only the kind column makes it
    // a profile row.
    {
      id: 1,
      factKey: 'user:role',
      factValue: 'I train small Qwen models',
      category: 'project',
      kind: 'profile',
      source: 'remember',
      updatedAt: iso(5),
    },
    {
      id: 2,
      factKey: 'project:stack',
      factValue: 'FastAPI backend',
      category: 'project',
      kind: 'fact',
      source: 'extracted',
      updatedAt: iso(30),
    },
    // A user-category fact that is NOT profile must keep reading as pref.
    {
      id: 3,
      factKey: 'user:editor',
      factValue: 'Prefers dark mode',
      category: 'user',
      kind: 'fact',
      source: 'remember',
      updatedAt: iso(60),
    },
  ];
}

function renderTab(id = 'memory-facts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pageFor(store: string) {
  const rows =
    store === 'facts'
      ? factRows
      : store === 'memory'
        ? [{ key: 'user:plant', value: 'My plant is named Gerald', updatedAt: iso(10) }]
        : store === 'heuristics'
          ? [{ id: 9, rule: 'Run tests after edits', source: 'lesson', category: 'workflow', updatedAt: iso(20) }]
          : [];
  return { store, rows, total: rows.length, limit: 200, offset: 0 };
}

/* Row titles render wrapped in typographic quotes, so an exact-string
 * text matcher can never hit them — match the text content instead. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rowByTitle = (title: string) =>
  screen
    .queryAllByTestId('memory-flat-row')
    .find((r) => within(r).queryByText(new RegExp(esc(title)))) ?? null;

/* waitFor() resolves the moment its callback stops throwing, so a nullable
 * lookup would hand back null on the very first paint. Throwing is what makes
 * it actually wait for the poll-based list query. */
const requireRow = (title: string) => {
  const r = rowByTitle(title);
  if (!r) throw new Error(`no row titled ${title} yet`);
  return r;
};

async function openMenu(title: string) {
  // The list is a poll-based query: wait for the row, don't assume it painted.
  const row = await waitFor(() => requireRow(title));
  fireEvent.click(within(row).getByTestId('memory-row-menu'));
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  seedFacts();

  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/brain/stores/')) {
      const name = decodeURIComponent(url.replace('/api/brain/stores/', '').split('?')[0]);
      return pageFor(name);
    }
    if (url.startsWith('/api/brain/stores')) {
      return {
        stores: [
          { name: 'facts', label: 'facts', count: factRows.length },
          { name: 'heuristics', label: 'heuristics', count: 1 },
          { name: 'memory', label: 'memory', count: 1 },
        ],
      };
    }
    if (url.startsWith('/api/brain/config')) return { config: {} };
    if (url.startsWith('/api/brain/consolidation/log')) return { entries: [] };
    if (url.startsWith('/api/august/memory/workspaces')) return { workspaces: [] };
    if (url.startsWith('/api/brain/integrity')) return { ok: true, exists: true, detail: 'ok' };
    if (url.startsWith('/api/brain/backups')) {
      return { backups: [], keep: 5, pendingRestore: null, directory: 'x' };
    }
    return {};
  });
});

/* ── 1 · the kind column wins over the category heuristic ────────────── */

it('reads a kind=profile fact as profile whatever its category', async () => {
  renderTab();
  const row = await waitFor(() => requireRow('I train small Qwen models'));
  expect(row).toHaveAttribute('data-kind', 'profile');
  expect(within(row).getByTestId('memory-kind-label')).toHaveTextContent('profile');
});

it('leaves non-profile rows on their existing derivation', async () => {
  renderTab();
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(4));
  expect(rowByTitle('FastAPI backend')).toHaveAttribute('data-kind', 'fact');
  expect(rowByTitle('Prefers dark mode')).toHaveAttribute('data-kind', 'pref');
  expect(rowByTitle('Run tests after edits')).toHaveAttribute('data-kind', 'lesson');
});

/* ── 2 · chip + filter ───────────────────────────────────────────────── */

it('counts profile rows in a chip and filters to them', async () => {
  renderTab();
  const chip = await screen.findByTestId('memory-kind-chip-profile');
  expect(chip).toHaveTextContent('1');

  fireEvent.click(chip);
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(1));
  expect(screen.getByTestId('memory-flat-row')).toHaveTextContent('I train small Qwen models');
  expect(rowByTitle('FastAPI backend')).toBeNull();
});

it('explains what the profile lane is whenever the chip is present', async () => {
  renderTab();
  const line = await screen.findByTestId('memory-profile-explainer');
  expect(line).toHaveTextContent('always in the model’s context on every turn');
  expect(line).toHaveTextContent('not recalled by keyword');
});

it('withholds the profile chip and its explainer when no row is profile', async () => {
  factRows = factRows.filter((r) => r.kind !== 'profile');
  renderTab();
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(3));
  expect(screen.queryByTestId('memory-kind-chip-profile')).toBeNull();
  expect(screen.queryByTestId('memory-profile-explainer')).toBeNull();
});

/* ── 3 · promote / demote, server-confirmed only ─────────────────────── */

it('promotes a fact through a PATCH of the kind column', async () => {
  renderTab();
  await openMenu('FastAPI backend');
  fireEvent.click(await screen.findByText('Add to profile'));

  await waitFor(() =>
    expect(patchMock).toHaveBeenCalledWith('/api/brain/stores/facts/2', { kind: 'profile' }),
  );
});

it('does not flip the chip locally while the server row still says fact', async () => {
  patchMock.mockImplementation(async () => ({ row: {} }));
  renderTab();
  await openMenu('FastAPI backend');
  fireEvent.click(await screen.findByText('Add to profile'));
  await waitFor(() => expect(patchMock).toHaveBeenCalled());

  // factRows was never mutated: the refetch re-reports kind='fact', so the row
  // must still read 'fact'. An optimistic flip would show 'profile' here.
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(4));
  expect(rowByTitle('FastAPI backend')).toHaveAttribute('data-kind', 'fact');
  expect(screen.getByTestId('memory-kind-chip-profile')).toHaveTextContent('1');
});

it('shows the promoted row as profile once the refetched kind comes back', async () => {
  patchMock.mockImplementation(async (_url, body) => {
    const kind = (body as { kind?: string }).kind;
    factRows = factRows.map((r) => (r.id === 2 ? { ...r, kind } : r));
    return { row: {} };
  });
  renderTab();
  await openMenu('FastAPI backend');
  fireEvent.click(await screen.findByText('Add to profile'));

  await waitFor(() => expect(rowByTitle('FastAPI backend')).toHaveAttribute('data-kind', 'profile'));
  await waitFor(() => expect(screen.getByTestId('memory-kind-chip-profile')).toHaveTextContent('2'));
});

it('demotes a profile row back to fact', async () => {
  patchMock.mockImplementation(async (_url, body) => {
    const kind = (body as { kind?: string }).kind;
    factRows = factRows.map((r) => (r.id === 1 ? { ...r, kind } : r));
    return { row: {} };
  });
  renderTab();

  const row = await openMenu('I train small Qwen models');
  const action = await screen.findByText('Remove from profile');
  expect(within(row).getByTestId('memory-kind-label')).toHaveTextContent('profile');
  fireEvent.click(action);

  await waitFor(() =>
    expect(patchMock).toHaveBeenCalledWith('/api/brain/stores/facts/1', { kind: 'fact' }),
  );
  await waitFor(() => expect(rowByTitle('I train small Qwen models')).toHaveAttribute('data-kind', 'fact'));
});

it('reports a failed lane write instead of pretending it landed', async () => {
  patchMock.mockImplementation(async () => {
    throw new Error('column "kind" is not writable');
  });
  const { toast } = await import('sonner');
  renderTab();
  await openMenu('FastAPI backend');
  fireEvent.click(await screen.findByText('Add to profile'));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('column "kind" is not writable'));
  expect(rowByTitle('FastAPI backend')).toHaveAttribute('data-kind', 'fact');
});

/* ── 4 · only the store with a kind column offers the action ─────────── */

it('offers no lane action on a KV note row', async () => {
  renderTab('memory-knowledge');
  await openMenu('user:plant');
  // View / Export / Delete render; the lane write would 400 on this store.
  expect(screen.getByRole('menuitem', { name: 'View' })).toBeInTheDocument();
  expect(screen.queryByText('Add to profile')).toBeNull();
  expect(screen.queryByText('Remove from profile')).toBeNull();
});
