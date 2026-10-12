/* ── MemorySection: the browse is the page ──────────────────────────────
 *
 * The complaint this pins down: the Memory page opened with ~1,600 characters
 * of toggle prose — five switches, each with a paragraph explaining what it
 * does — and not one stored memory. The list was a click deep behind an "All
 * global memories" row, so the page whose entire job is to show what August
 * remembers showed nothing about it.
 *
 * Three contracts, all of which are about ORDER and LABELLING rather than
 * colour:
 *   1. the browse renders above the behaviour toggles;
 *   2. a row carries no per-row kind chip — the kind is a group header, which
 *      is how the reference labels a memory (by the section it sits under);
 *   3. a title is not wrapped in literal quotation marks, and a row with more
 *      to say than its 60-char derived name shows that text.
 *
 * jsdom has no layout engine, so DOM order and content are asserted rather
 * than pixels. */

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
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/* A short fact, where the derived title and the body are the same string, and
 * a long one, where the backend's 60-char cap means they genuinely differ. */
const FACT_ROWS = [
  {
    id: 1,
    factKey: 'user:editor',
    factValue: JSON.stringify({ fact: 'Prefers dark mode.' }),
    title: 'Prefers dark mode.',
    kind: 'profile',
    category: 'user',
    source: 'remember',
    updatedAt: iso(5),
  },
  {
    id: 2,
    factKey: 'lesson:cache',
    factValue: JSON.stringify({
      fact: 'A stale cache is cheaper to bust than to debug, because the failure is loud and the fix is one line.',
    }),
    title: 'A stale cache is cheaper to bust',
    kind: 'lesson',
    category: 'general',
    source: '',
    updatedAt: iso(60),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  /* api.get is awaited by the section, so the fake has to answer with a Promise.
   * Returning one explicitly — rather than marking the selector `async` with
   * nothing to await — is what the require-await rule was asking for. */
  const pickBrowseResponse = (url: string): unknown => {
    if (url.startsWith('/api/brain/stores/facts')) {
      return { store: 'facts', rows: FACT_ROWS, total: FACT_ROWS.length, limit: 200, offset: 0 };
    }
    if (url.startsWith('/api/brain/stores/')) return { store: 'x', rows: [], total: 0, limit: 200, offset: 0 };
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
  };

  getMock.mockImplementation(
    (url: string): Promise<unknown> => Promise.resolve(pickBrowseResponse(url)),
  );
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

describe('MemorySection — the browse is the page', () => {
  it('renders the memory browse above the behaviour toggles', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('memory-group-global')).toBeTruthy());
    expect(screen.getByTestId('memory-group-behavior')).toBeTruthy();

    const order = [...document.querySelectorAll('[data-testid]')].map((e) =>
      e.getAttribute('data-testid'),
    );
    // The content must come before the prose about the content's switches.
    expect(order.indexOf('memory-group-global')).toBeLessThan(
      order.indexOf('memory-group-behavior'),
    );
  });

  it('drops the per-row kind chip and the quotation marks around titles', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-global-row'));
    const rows = await screen.findAllByTestId('memory-flat-row');
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Kind survives as an attribute (and as a group header when filtered);
      // the 56px chip repeated on every line is gone.
      expect(row.getAttribute('data-kind')).toBeTruthy();
      expect(within(row).queryByTestId('memory-kind-label')).toBeNull();
      // A quoted title reads as a blob lifted out of a transcript.
      expect(row.textContent ?? '').not.toContain('“');
    }
  });

  it('shows the rest of a long fact instead of truncating it into a tooltip', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-global-row'));
    const rows = await screen.findAllByTestId('memory-flat-row');
    const long = rows.find((r) => r.textContent?.includes('A stale cache'));
    expect(long).toBeTruthy();
    // The backend caps the derived title at 60 chars; the remainder used to be
    // reachable only through the row's title attribute.
    expect(long!.textContent ?? '').toContain('because the failure is loud');
  });

  it('does not print the same words twice when title and body are the same', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('memory-global-row'));
    const rows = await screen.findAllByTestId('memory-flat-row');
    const short = rows.find((r) => r.textContent?.includes('Prefers dark mode'));
    expect(short).toBeTruthy();
    const hits = (short!.textContent ?? '').split('Prefers dark mode').length - 1;
    expect(hits).toBe(1);
  });
});