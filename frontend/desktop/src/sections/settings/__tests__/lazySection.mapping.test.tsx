/* Regression: lazySection crash for pre-mapped loaders (2026-09-10).
 *
 * Subagents/Plugins/Browser settings tabs threw
 *   "Element type is invalid. Received a promise that resolves to:
 *    undefined. Lazy element type must resolve to a class or function."
 * because their loaders .then()-map the module to { default: X } and
 * lazySection then looked up the raw name on that object → undefined.
 * (Introduced 38944632, 2026-09-07, when the three wrappers were wired.)
 * lazySection now falls back to m.default; this test renders one of the
 * mapped wrappers end-to-end. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Suspense, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(async () => ({
      maxConcurrent: 5,
      maxIterations: 50,
      maxDepth: 1,
      worktreeIsolation: false,
    })),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
  },
}));
vi.mock('@/api/subagents', () => ({
  listActive: vi.fn(async () => ({ agents: [] })),
}));

describe('lazySection wrappers', () => {
  it('renders the .then()-mapped Subagents section instead of crashing', { timeout: 30_000 }, async () => {
    const { SECTION_COMPONENTS } = await import('@/sections/settings/SettingsPage');
    const Wrapper = SECTION_COMPONENTS['subagents'];
    expect(Wrapper).toBeTruthy();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Suspense fallback={<div data-testid="lazy-fallback">loading</div>}>
          {createElement(Wrapper, { active: {} as never })}
        </Suspense>
      </QueryClientProvider>,
    );
    // The crash was a thrown promise-resolution, so waiting for the real
    // heading is the assertion (fallback text must be replaced). The budget
    // is generous: SettingsPage is a huge graph to dynamically import, and
    // this can race the backend suite for CPU under full-gate runs.
    await waitFor(() => expect(screen.getByText('Subagents')).toBeTruthy(), {
      timeout: 15_000,
    });
  });
});
