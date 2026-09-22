/* ── MemorySection: brain-database backup + restore controls ─────────── */
/* The "Memory files" card is a read-out of two endpoints that already carry
 * every judgement it displays: `GET /api/brain/integrity` (live DB) and
 * `GET /api/brain/backups` (each copy health-checked server-side + what is
 * staged). Three promises this file pins, each by mutating the payload that
 * carries it:
 *   1. a bad integrity verdict prints the server's `detail`, never a green
 *      "healthy" pill;
 *   2. an unhealthy or from-the-future copy is NOT restorable, and the row
 *      says why in the server's own words;
 *   3. the staged-restore banner follows `pendingRestore` from the server —
 *      visible on load with no click, and only after a confirmed POST. */

import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, configure } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Poll-based react-query reads need more than the 1s findBy default.
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
const postMock = vi.mocked(api.post);
const deleteMock = vi.mocked(api.delete);

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const BACKUP_DIR = 'C:\\Users\\me\\AppData\\Roaming\\August\\brain\\backups';
const DB_PATH = 'C:\\Users\\me\\AppData\\Roaming\\August\\brain\\brain.sqlite';

/* Mutable so a mutation's refetch can return a different server state — the
 * card must follow that, not remember its own clicks. */
let integrity: Record<string, unknown>;
let backups: Record<string, unknown>;
let createResult: Record<string, unknown> | Error;
let restoreResult: Record<string, unknown> | Error;

const good = {
  name: 'brain-2026-09-20T09-00-00-manual.sqlite',
  bytes: 2_465_792,
  createdAt: iso(30),
  healthy: true,
  appliedVersion: 46,
  fromTheFuture: false,
};
const corrupt = {
  name: 'brain-2026-09-19T09-00-00-startup.sqlite',
  bytes: 1024,
  createdAt: iso(60 * 26),
  healthy: false,
  appliedVersion: 0,
  fromTheFuture: false,
  error: '*** in database main ***',
};
const future = {
  name: 'brain-2026-09-21T09-00-00-manual.sqlite',
  bytes: 1024,
  createdAt: iso(10),
  healthy: true,
  appliedVersion: 99,
  fromTheFuture: true,
};

function resetPayloads() {
  integrity = {
    ok: true,
    exists: true,
    detail: 'ok',
    path: DB_PATH,
    backups: 1,
    pendingRestore: null,
  };
  backups = {
    backups: [good, corrupt, future],
    keep: 5,
    pendingRestore: null,
    directory: BACKUP_DIR,
  };
  createResult = {
    ok: true,
    name: 'brain-2026-09-22T08-30-00-manual.sqlite',
    bytes: 2_465_792,
    appliedVersion: 46,
    pruned: ['brain-2026-09-01T00-00-00-auto.sqlite', 'brain-2026-09-02T00-00-00-auto.sqlite'],
  };
  restoreResult = {
    ok: true,
    name: good.name,
    appliesOn: 'next-launch',
    note: 'Restart August to apply it.',
  };
}

function storePayload(url: string) {
  const name = decodeURIComponent(url.replace('/api/brain/stores/', '').split('?')[0]);
  if (name === 'facts') {
    return {
      store: 'facts',
      rows: [
        {
          id: 2,
          factKey: 'project:stack',
          factValue: 'FastAPI backend',
          category: 'project',
          kind: 'fact',
          source: 'extracted',
          updatedAt: iso(120),
        },
      ],
      total: 1,
      limit: 200,
      offset: 0,
    };
  }
  return { store: name, rows: [], total: 0, limit: 200, offset: 0 };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MemorySection active={{ id: 'memory-facts' }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPayloads();

  getMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/brain/integrity')) return integrity;
    if (url.startsWith('/api/brain/backups')) return backups;
    if (url.startsWith('/api/brain/stores/')) return storePayload(url);
    if (url.startsWith('/api/brain/stores')) {
      return { stores: [{ name: 'facts', label: 'facts', count: 1 }] };
    }
    if (url.startsWith('/api/brain/config')) return { config: {} };
    if (url.startsWith('/api/brain/consolidation/log')) return { entries: [] };
    if (url.startsWith('/api/august/memory/workspaces')) return { workspaces: [] };
    return {};
  });

  postMock.mockImplementation(async (url: string, body?: unknown) => {
    if (url === '/api/brain/backups') {
      // A failed POST rejects the promise — that is how api-client surfaces a
      // 500 with `detail`, and it is what the error path is tested against.
      if (createResult instanceof Error) throw createResult;
      return createResult;
    }
    if (url === '/api/brain/backups/restore') {
      if (restoreResult instanceof Error) throw restoreResult;
      // The server is the one that starts reporting pendingRestore.
      backups = { ...backups, pendingRestore: (body as { name: string }).name };
      return restoreResult;
    }
    return {};
  });

  deleteMock.mockImplementation(async (url: string) => {
    if (url === '/api/brain/backups/restore') {
      backups = { ...backups, pendingRestore: null };
      return { ok: true, cancelled: true };
    }
    return {};
  });
});

/* ── 1 · live integrity ──────────────────────────────────────────────── */

it('shows the server integrity detail verbatim instead of a healthy pill', async () => {
  integrity = {
    ok: false,
    exists: true,
    detail: '*** in database main ***\nPage 14 btree cell 2 out of place',
    path: DB_PATH,
    backups: 0,
    pendingRestore: null,
  };
  renderCard();

  await expect(screen.findByTestId('memory-integrity-detail')).resolves.toHaveTextContent(
    'Page 14 btree cell 2 out of place',
  );
  // The green pill must not render alongside a failed check.
  expect(screen.queryByTestId('memory-integrity-ok')).toBeNull();
});

it('labels a healthy database healthy only when the check passes', async () => {
  renderCard();
  await expect(screen.findByTestId('memory-integrity-ok')).resolves.toHaveTextContent('healthy');
  expect(screen.queryByTestId('memory-integrity-detail')).toBeNull();
});

it('does not call a missing database healthy even though ok is true', async () => {
  // The endpoint really does return ok:true when there is no file yet.
  integrity = { ok: true, exists: false, detail: 'no database yet' };
  renderCard();
  await expect(screen.findByTestId('memory-integrity-missing')).resolves.toHaveTextContent(
    'no database yet',
  );
  expect(screen.queryByTestId('memory-integrity-ok')).toBeNull();
});

/* ── 2 · back up now ─────────────────────────────────────────────────── */

it('backs up on demand and reports the new name, size and retired copies', async () => {
  renderCard();
  fireEvent.click(await screen.findByTestId('memory-backup-now'));

  await waitFor(() =>
    expect(postMock).toHaveBeenCalledWith('/api/brain/backups', { reason: 'manual' }),
  );
  const line = await screen.findByTestId('memory-backup-created');
  expect(line).toHaveTextContent('brain-2026-09-22T08-30-00-manual.sqlite');
  expect(line).toHaveTextContent('2.4 MB');
  expect(line).toHaveTextContent('retired 2 older copies');
  // Retention has to be stated, or a copy vanishing looks like data loss.
  expect(line).toHaveTextContent('keeps the newest 5');
});

it('surfaces a failed backup as an error and writes no success line', async () => {
  createResult = new Error('backup failed verification: *** in database main ***');
  const { toast } = await import('sonner');
  renderCard();
  fireEvent.click(await screen.findByTestId('memory-backup-now'));

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('backup failed verification: *** in database main ***'),
  );
  expect(screen.queryByTestId('memory-backup-created')).toBeNull();
});

/* ── 3 · per-row health gates the restore ────────────────────────────── */

async function renderRows() {
  renderCard();
  await screen.findByTestId('memory-backup-list');
  return screen.getAllByTestId('memory-backup-row');
}

it('enables Restore only on a verified copy and states the server reason otherwise', async () => {
  const rows = await renderRows();
  expect(rows).toHaveLength(3);

  const byName = (name: string) => rows.find((r) => within(r).queryByText(name))!;

  const okRow = byName(good.name);
  expect(within(okRow).getByTestId('memory-backup-status')).toHaveTextContent('verified');
  expect(within(okRow).getByTestId('memory-backup-restore')).not.toBeDisabled();
  expect(okRow).toHaveTextContent('2.4 MB');

  const badRow = byName(corrupt.name);
  expect(within(badRow).getByTestId('memory-backup-restore')).toBeDisabled();
  expect(within(badRow).getByTestId('memory-backup-status')).toHaveTextContent(
    'unhealthy · *** in database main ***',
  );

  const futureRow = byName(future.name);
  expect(within(futureRow).getByTestId('memory-backup-restore')).toBeDisabled();
  expect(within(futureRow).getByTestId('memory-backup-status')).toHaveTextContent(
    'from a newer version · schema 99',
  );
});

it('shows a human-readable size and an age, not a raw byte count', async () => {
  const rows = await renderRows();
  expect(within(rows[1]).getByText('1.0 KB')).toBeInTheDocument();
  expect(within(rows[1]).getByText('1d ago')).toBeInTheDocument();
});

/* ── 4 · restore needs an awaited confirm ────────────────────────────── */

it('asks before staging, states next launch and .pre-restore, and fires nothing on cancel', async () => {
  const rows = await renderRows();
  const okRow = rows.find((r) => within(r).queryByText(good.name))!;

  fireEvent.click(within(okRow).getByTestId('memory-backup-restore'));
  const dialog = await screen.findByTestId('confirm-dialog');
  expect(dialog).toHaveTextContent('NEXT LAUNCH');
  expect(dialog).toHaveTextContent('.pre-restore');
  // The confirm is awaited: nothing reaches the server while it is open.
  expect(postMock).not.toHaveBeenCalledWith('/api/brain/backups/restore', expect.anything());

  fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel/ }));
  await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
  expect(postMock).not.toHaveBeenCalledWith('/api/brain/backups/restore', expect.anything());
  expect(screen.queryByTestId('memory-restore-banner')).toBeNull();
});

it('stages the restore on confirm and shows the persistent banner', async () => {
  const rows = await renderRows();
  const okRow = rows.find((r) => within(r).queryByText(good.name))!;

  fireEvent.click(within(okRow).getByTestId('memory-backup-restore'));
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

  await waitFor(() =>
    expect(postMock).toHaveBeenCalledWith('/api/brain/backups/restore', { name: good.name }),
  );
  const banner = await screen.findByTestId('memory-restore-banner');
  expect(banner).toHaveTextContent('Restore staged — restart August to apply');
  expect(banner).toHaveTextContent(good.name);
  expect(within(okRow).getByTestId('memory-backup-staged')).toBeInTheDocument();
});

it('surfaces the server refusal and stages no banner', async () => {
  restoreResult = new Error('backup is at schema 099, this build knows up to 046');
  const { toast } = await import('sonner');
  const rows = await renderRows();
  const okRow = rows.find((r) => within(r).queryByText(good.name))!;

  fireEvent.click(within(okRow).getByTestId('memory-backup-restore'));
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('schema 099')));
  expect(screen.queryByTestId('memory-restore-banner')).toBeNull();
});

/* ── 5 · the banner follows the server, not local state ──────────────── */

it('shows the staged banner on first load when the server reports pendingRestore', async () => {
  backups = { ...backups, pendingRestore: corrupt.name };
  renderCard();

  // No click, no mutation: the server alone put the banner up.
  const banner = await screen.findByTestId('memory-restore-banner');
  expect(banner).toHaveTextContent(corrupt.name);
  expect(postMock).not.toHaveBeenCalledWith('/api/brain/backups/restore', expect.anything());
});

it('cancels a staged restore through the DELETE endpoint and drops the banner', async () => {
  backups = { ...backups, pendingRestore: good.name };
  renderCard();
  const banner = await screen.findByTestId('memory-restore-banner');

  fireEvent.click(within(banner).getByTestId('memory-restore-cancel'));
  await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('/api/brain/backups/restore'));
  await waitFor(() => expect(screen.queryByTestId('memory-restore-banner')).toBeNull());
});

/* ── 6 · where the files are ─────────────────────────────────────────── */

it('prints the backups directory and the live database path', async () => {
  renderCard();
  await expect(screen.findByTestId('memory-backup-dir')).resolves.toHaveTextContent(BACKUP_DIR);
  await expect(screen.findByTestId('memory-db-path')).resolves.toHaveTextContent(DB_PATH);
});

/* ── 7 · the gate is the server's flag, never a locally compared version ── */

it('restores by the server flag alone, not by a local schema-version check', async () => {
  // appliedVersion far above anything this build could know, but the server
  // still reports it usable: a local `appliedVersion === current` gate would
  // wrongly disable this row.
  const modern = {
    name: 'brain-2026-09-22T07-00-00-manual.sqlite',
    bytes: 2048,
    createdAt: iso(20),
    healthy: true,
    appliedVersion: 400,
    fromTheFuture: false,
  };
  // The inverse: flagged from-the-future by the server even though the number
  // is modest. Only the flag decides.
  const flagged = { ...good, name: 'brain-2026-09-22T06-00-00-manual.sqlite', appliedVersion: 3, fromTheFuture: true };
  backups = { ...backups, backups: [modern, flagged] };
  renderCard();
  const rows = await screen.findByTestId('memory-backup-list');
  const [modernRow, flaggedRow] = within(rows).getAllByTestId('memory-backup-row');

  expect(within(modernRow).getByTestId('memory-backup-restore')).not.toBeDisabled();
  expect(within(modernRow).getByTestId('memory-backup-status')).toHaveTextContent('verified');
  expect(within(flaggedRow).getByTestId('memory-backup-restore')).toBeDisabled();
  expect(within(flaggedRow).getByTestId('memory-backup-status')).toHaveTextContent('from a newer version');
});

/* ── 8 · retention is said out loud wherever a copy disappears ───────── */

it('states the retention rule on the success line and beside the list', async () => {
  renderCard();
  // Persistent: a reader who only ever sees the list still learns why copies
  // vanish. Stated once, next to the list, rather than duplicated per row.
  await expect(screen.findByTestId('memory-backup-list')).resolves.toBeInTheDocument();
  expect(screen.getByTestId('memory-files-card')).toHaveTextContent('Keeps the newest 5 copies');

  fireEvent.click(screen.getByTestId('memory-backup-now'));
  await waitFor(() => expect(postMock).toHaveBeenCalled());
  await expect(screen.findByTestId('memory-backup-created')).resolves.toHaveTextContent(
    'this app keeps the newest 5',
  );
});

/* ── 9 · the cancel path fires nothing at all ────────────────────────── */

it('fires neither a restore nor a cancel when the confirm is dismissed', async () => {
  const rows = await renderRows();
  const okRow = rows.find((r) => within(r).queryByText(good.name))!;

  fireEvent.click(within(okRow).getByTestId('memory-backup-restore'));
  const dialog = await screen.findByTestId('confirm-dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel/ }));
  await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());

  expect(postMock).not.toHaveBeenCalledWith('/api/brain/backups/restore', expect.anything());
  expect(deleteMock).not.toHaveBeenCalled();
  expect(screen.queryByTestId('memory-restore-banner')).toBeNull();
});

it('refuses to render a staged banner the server did not report', async () => {
  // The POST succeeds, yet the server still says nothing is staged. The banner
  // follows `pendingRestore` from the query, so it must stay hidden.
  postMock.mockImplementation(async () => ({
    ok: true,
    name: good.name,
    appliesOn: 'next-launch',
    note: 'x',
  }));
  const rows = await renderRows();
  const okRow = rows.find((r) => within(r).queryByText(good.name))!;

  fireEvent.click(within(okRow).getByTestId('memory-backup-restore'));
  fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
  await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/brain/backups/restore', { name: good.name }));
  expect(screen.queryByTestId('memory-restore-banner')).toBeNull();
});

/* ── 10 · a disabled button carries the server reason verbatim ───────── */

it('puts the refusal reason on the disabled button as well as the row', async () => {
  const rows = await renderRows();
  const badRow = rows.find((r) => within(r).queryByText(corrupt.name))!;
  const button = within(badRow).getByTestId('memory-backup-restore');

  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', expect.stringContaining('*** in database main ***'));
  expect(within(badRow).getByTestId('memory-backup-status')).toHaveTextContent(corrupt.error);
});
