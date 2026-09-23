import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from 'sonner';
import { ModelFamiliesSection } from '../ModelFamiliesSection';

const BUILTIN = [
  {
    id: 'openai-reasoning',
    tokens: ['o1', 'gpt-5'],
    excludes: [],
    reasoningEffort: true,
    extendedThinking: false,
    defaultEffort: null,
    maxEffort: null,
    source: 'builtin',
  },
];

const OPERATOR = [
  {
    id: 'vectorgen',
    tokens: ['vg-4'],
    excludes: ['vg-4-mini'],
    reasoningEffort: true,
    extendedThinking: false,
    defaultEffort: 'medium',
    maxEffort: null,
    source: 'config',
  },
];

function payload(body: unknown) {
  return JSON.parse(String(body)) as { families: unknown[] };
}

function stubFetch(next: { operator?: typeof OPERATOR; builtin?: typeof BUILTIN } = {}, ok = true) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = {
        operator: next.operator ?? [],
        builtin: next.builtin ?? BUILTIN,
        rules: 'a family needs a non-empty "id"…',
      };
      return Promise.resolve(
        new Response(
          JSON.stringify(
            ok ? body : { detail: { code: 'validation', message: 'family #1 is not valid — needs tokens' } },
          ),
          { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
  return calls;
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelFamiliesSection />
    </QueryClientProvider>,
  );
}

describe('ModelFamiliesSection', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists the operator overrides the server reports', async () => {
    stubFetch({ operator: OPERATOR });
    renderSection();

    expect(await screen.findByDisplayValue('vectorgen')).toBeInTheDocument();
    expect(screen.getByDisplayValue('vg-4')).toBeInTheDocument();
    expect(screen.getByDisplayValue('vg-4-mini')).toBeInTheDocument();
  });

  it('saves the whole table without the source tag and parses comma lists', async () => {
    const calls = stubFetch({ operator: OPERATOR });
    renderSection();
    await screen.findByDisplayValue('vectorgen');

    fireEvent.click(screen.getByRole('button', { name: /Add family/ }));
    fireEvent.change(screen.getAllByLabelText('Family id')[1], { target: { value: 'nova' } });
    fireEvent.change(screen.getAllByLabelText('Model-id substrings')[1], {
      target: { value: 'Nova-Pro, nova-lite' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const put = calls.find((c) => c.url === '/api/config/model-params' && c.init?.method === 'PUT');
      expect(put).toBeTruthy();
    });
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    const families = payload(put.init!.body).families as Record<string, unknown>[];
    expect(families).toHaveLength(2);
    expect(families[0]).toMatchObject({ id: 'vectorgen', tokens: ['vg-4'], excludes: ['vg-4-mini'] });
    // Typed with spaces and capitals: the server lowercases, but the split has
    // to drop the empty entries a trailing comma would leave.
    expect(families[1]).toMatchObject({ id: 'nova', tokens: ['nova-pro', 'nova-lite'] });
    expect(families[0].source).toBeUndefined();
  });

  it('surfaces the server reason instead of a generic failure', async () => {
    stubFetch({}, false);
    renderSection();
    await screen.findByText('Built-in table');

    fireEvent.click(screen.getByRole('button', { name: /Add family/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/family #1 is not valid/);
  });

  it('copies a built-in row into the editor so an override keeps its tokens', async () => {
    stubFetch({ operator: [] });
    renderSection();
    // The "Built-in table" heading is static; wait for the row itself.
    await screen.findByText('openai-reasoning');

    fireEvent.click(screen.getByRole('button', { name: 'Override' }));

    expect(screen.getByDisplayValue('openai-reasoning')).toBeInTheDocument();
    expect(screen.getByDisplayValue('o1, gpt-5')).toBeInTheDocument();
    expect(screen.getByText('replaced by yours')).toBeInTheDocument();
  });

  it('answers what a model id gets from the resolver endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) => {
        const body = String(url).startsWith('/api/config/model-params/resolve')
          ? {
              modelId: 'mystery-9b',
              family: null,
              reasoningEffort: false,
              extendedThinking: false,
              defaultEffort: null,
              maxEffort: null,
            }
          : { operator: [], builtin: BUILTIN, rules: '' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    renderSection();

    fireEvent.change(screen.getByLabelText('Model id to check'), {
      target: { value: 'mystery-9b' },
    });

    const answer = await screen.findByTestId('family-resolution');
    expect(answer).toHaveTextContent('No family matches');
    expect(answer).toHaveTextContent('neither reasoning_effort nor a thinking budget');
  });

  it('keeps Save disabled until something actually changes', async () => {
    stubFetch({ operator: OPERATOR });
    renderSection();
    await screen.findByDisplayValue('vectorgen');

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Add family/ }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
