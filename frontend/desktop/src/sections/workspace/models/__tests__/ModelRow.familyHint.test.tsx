import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Provider } from '@/api/providers';
import { ModelRow } from '../ModelRow';

const MODEL = {
  id: 'deepseek-chat',
  name: 'DeepSeek Chat',
} as unknown as Provider['models'][number];

function renderRow(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const RESOLVED = {
  modelId: 'deepseek-chat',
  family: { id: 'deepseek', source: 'builtin' },
  reasoningEffort: true,
  extendedThinking: false,
};

describe('ModelRow — what stands behind "Auto (heuristic)"', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(RESOLVED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('names the family and what it permits, asked of the same endpoint the harness uses', async () => {
    renderRow(<ModelRow providerId="p1" model={MODEL} onChanged={() => {}} />);
    fireEvent.click(screen.getByLabelText('Edit model'));

    const hint = await screen.findByTestId('model-family-hint');
    expect(hint).toHaveTextContent('deepseek');
    expect(hint).toHaveTextContent('built-in');
    expect(hint).toHaveTextContent('reasoning_effort sent');
    expect(hint).toHaveTextContent('thinking budget never sent');
  });

  it('says nothing once the user pins the answer themselves', async () => {
    renderRow(<ModelRow providerId="p1" model={MODEL} onChanged={() => {}} />);
    fireEvent.click(screen.getByLabelText('Edit model'));
    await screen.findByTestId('model-family-hint');

    fireEvent.change(screen.getByLabelText('Supports reasoning_effort'), {
      target: { value: 'yes' },
    });

    expect(screen.queryByTestId('model-family-hint')).not.toBeInTheDocument();
  });

  it('tells the user how to teach August about an unmatched model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((): Promise<Response> =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              modelId: 'deepseek-chat',
              family: null,
              reasoningEffort: false,
              extendedThinking: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      ),
    );
    renderRow(<ModelRow providerId="p1" model={MODEL} onChanged={() => {}} />);
    fireEvent.click(screen.getByLabelText('Edit model'));

    const hint = await screen.findByTestId('model-family-hint');
    expect(hint).toHaveTextContent('no capability family matches');
    expect(hint).toHaveTextContent('Settings → Model Families');
  });
});
