/* ── MemorySection: the profile lane is visible and correctable ──────── */
/* `kind='profile'` facts are the always-in-context lane the backend injects on
 * every turn (services/memory_store/fact_retrieval.py), so the browse UI must
 * read the row's real `kind` column — not re-derive it from category — and let
 * you move a row in or out.
 *
 * The second half matters as much as the first: the lane action PATCHes and
 * then waits. A locally flipped label would tell you a fact is riding along on
 * every turn when the server never accepted it. These tests pin both the write
 * AND that the label only changes once the refetched row says so.
 *
 * The lane action lives in the entry's DETAIL view, not on the row: it is a
 * per-entry decision, not something you do while scanning a list. */

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

async function renderTab(id = 'memory-facts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return utils;
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

/* Row titles are the entry's own text, so an exact-string matcher can hit them;
 * match on the text content anyway to stay robust to the description column. */
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

/** Open a row's detail view — the one click that replaces the ⋯ menu. */
async function openRow(title: string) {
  const row = await waitFor(() => requireRow(title));
  fireEvent.click(within(row).getByTestId('memory-row-open'));
  return row;
}

/** The count of fact-store reads, so a test can wait for the refetch a write
 *  triggers instead of assuming the first paint already reflects it. */
const factReads = () =>
  getMock.mock.calls.filter((c) => String(c[0]).includes('/api/brain/stores/facts')).length;

const laneButton = () => screen.getByTestId('memory-detail-toggle-lane');
const backToList = () => fireEvent.click(screen.getByTestId('memory-detail-back'));

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
  await renderTab();
  const row = await waitFor(() => requireRow('I train small Qwen models'));
  expect(row).toHaveAttribute('data-kind', 'profile');
  // The per-row kind chip is gone by design: it was a 56px coloured badge
  // stamped on every single line, where the reference labels a memory by the
  // GROUP it sits under. `data-kind` on the row is the stable contract for
  // which kind this is, and the lane has its own named section.
  expect(within(row).queryByTestId('memory-kind-label')).toBeNull();
  expect(within(screen.getByTestId('memory-section-you')).getByTestId('memory-flat-row')).toBe(row);
});

it('leaves non-profile rows on their existing derivation', async () => {
  await renderTab();
  // 3 facts + 1 legacy lesson + 1 KV note: the sections merge stores.
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(5));
  expect(rowByTitle('FastAPI backend')).toHaveAttribute('data-kind', 'fact');
  expect(rowByTitle('Prefers dark mode')).toHaveAttribute('data-kind', 'pref');
  expect(rowByTitle('Run tests after edits')).toHaveAttribute('data-kind', 'lesson');
});

/* ── 2 · the lane is a section, not a chip row ───────────────────────── */

it('puts the profile row in its own section and leaves the rest under Topics', async () => {
  await renderTab();
  const you = await screen.findByTestId('memory-section-you');
  expect(within(you).getAllByTestId('memory-flat-row')).toHaveLength(1);
  expect(within(you).getByTestId('memory-flat-row')).toHaveTextContent('I train small Qwen models');

  const topics = screen.getByTestId('memory-section-topics');
  const topicTitles = within(topics)
    .getAllByTestId('memory-flat-row')
    .map((r) => r.textContent ?? '');
  expect(topicTitles).toHaveLength(2);
  expect(topicTitles.some((t) => t.includes('FastAPI backend'))).toBe(true);
  expect(topicTitles.some((t) => t.includes('Prefers dark mode'))).toBe(true);
});

it('explains what the profile lane is whenever the section is present', async () => {
  await renderTab();
  const line = await screen.findByTestId('memory-profile-explainer');
  // The claim is about what the model SEES: injected every turn, not recalled
  // by keyword — and a parked row is carried by neither lane until restored.
  expect(line).toHaveTextContent('injected into every turn');
  expect(line).toHaveTextContent('not recalled by keyword');
  expect(line).toHaveTextContent('open one to add or remove it from the lane');
});

it('withholds the lane section and its explainer when no row is profile', async () => {
  factRows = factRows.filter((r) => r.kind !== 'profile');
  await renderTab();
  await waitFor(() => expect(screen.getAllByTestId('memory-flat-row')).toHaveLength(4));
  expect(screen.queryByTestId('memory-section-you')).toBeNull();
  expect(screen.queryByTestId('memory-profile-explainer')).toBeNull();
});

/* ── 3 · promote / demote, server-confirmed only ─────────────────────── */

it('promotes a fact through a PATCH of the kind column', async () => {
  await renderTab();
  await openRow('FastAPI backend');
  fireEvent.click(await screen.findByTestId('memory-detail-toggle-lane'));

  await waitFor(() =>
    expect(patchMock).toHaveBeenCalledWith('/api/brain/stores/facts/2', { kind: 'profile' }),
  );
});

it('does not flip the lane label locally while the server row still says fact', async () => {
  patchMock.mockImplementation(async () => ({ row: {} }));
  await renderTab();
  await openRow('FastAPI backend');
  const lane = await screen.findByTestId('memory-detail-toggle-lane');
  expect(lane).toHaveTextContent('Always include in context');

  const reads = factReads();
  fireEvent.click(lane);
  await waitFor(() => expect(patchMock).toHaveBeenCalled());
  // Wait for the invalidation refetch to actually land before judging the
  // label — otherwise the assertion passes on the pre-refetch paint.
  await waitFor(() => expect(factReads()).toBeGreaterThan(reads));

  // factRows was never mutated: the refetch re-reports kind='fact', so the
  // detail must still offer the PROMOTE action. An optimistic flip would
  // show the demote label here.
  expect(laneButton()).toHaveTextContent('Always include in context');

  backToList();
  await waitFor(() => expect(requireRow('FastAPI backend')).toHaveAttribute('data-kind', 'fact'));
});

it('shows the promoted row as profile once the refetched kind comes back', async () => {
  patchMock.mockImplementation(async (_url, body) => {
    const kind = (body as { kind?: string }).kind;
    factRows = factRows.map((r) => (r.id === 2 ? { ...r, kind } : r));
    return { row: {} };
  });
  await renderTab();
  await openRow('FastAPI backend');
  fireEvent.click(await screen.findByTestId('memory-detail-toggle-lane'));

  // The detail reads the REFETCHED row, so its own label flips without a
  // navigate-back — the fix for "the snapshot went stale".
  await waitFor(() => expect(laneButton()).toHaveTextContent('Remove from the always-in-context lane'));

  backToList();
  await waitFor(() => expect(requireRow('FastAPI backend')).toHaveAttribute('data-kind', 'profile'));
  // …and it now sits in the lane's own section, beside the row already there.
  const laneRows = within(screen.getByTestId('memory-section-you')).getAllByTestId('memory-flat-row');
  expect(laneRows).toHaveLength(2);
  expect(laneRows.some((r) => r.textContent?.includes('FastAPI backend'))).toBe(true);
});

it('demotes a profile row back to fact', async () => {
  patchMock.mockImplementation(async (_url, body) => {
    const kind = (body as { kind?: string }).kind;
    factRows = factRows.map((r) => (r.id === 1 ? { ...r, kind } : r));
    return { row: {} };
  });
  await renderTab();

  const row = await openRow('I train small Qwen models');
  // `data-kind` is what says a row is profile now that the per-row kind chip
  // is gone (see the note in "reads a kind=profile fact as profile").
  expect(row).toHaveAttribute('data-kind', 'profile');
  const lane = await screen.findByTestId('memory-detail-toggle-lane');
  expect(lane).toHaveTextContent('Remove from the always-in-context lane');
  fireEvent.click(lane);

  await waitFor(() =>
    expect(patchMock).toHaveBeenCalledWith('/api/brain/stores/facts/1', { kind: 'fact' }),
  );
  backToList();
  await waitFor(() => expect(requireRow('I train small Qwen models')).toHaveAttribute('data-kind', 'fact'));
});

it('reports a failed lane write instead of pretending it landed', async () => {
  patchMock.mockImplementation(async () => {
    throw new Error('column "kind" is not writable');
  });
  const { toast } = await import('sonner');
  await renderTab();
  await openRow('FastAPI backend');
  const lane = await screen.findByTestId('memory-detail-toggle-lane');
  fireEvent.click(lane);

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('column "kind" is not writable'));
  expect(laneButton()).toHaveTextContent('Always include in context');
});

/* ── 4 · only the store with a kind column offers the action ─────────── */

it('offers no lane action on a KV note row', async () => {
  await renderTab('memory-knowledge');
  // The note reads as its text, not as the key the store files it under —
  // `user:plant` is a handle for remember/forget, not something to show a user.
  await openRow('My plant is named Gerald');
  await screen.findByTestId('memory-detail-view');
  expect(rowByTitle('user:plant')).toBeNull();
  // Edit / Export / Delete render; the lane write would 400 on this store.
  expect(screen.getByTestId('memory-detail-delete')).toBeInTheDocument();
  expect(screen.queryByTestId('memory-detail-toggle-lane')).toBeNull();
});
