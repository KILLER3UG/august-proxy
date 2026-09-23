import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Provider } from '@/api/providers';
import { ModelRow } from '../ModelRow';

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({ updated: true })),
    delete: vi.fn(async () => ({})),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';

function model(overrides: Partial<Provider['models'][number]> = {}) {
  return {
    id: 'qwen3:0.6b',
    name: 'Qwen3 0.6B',
    source: 'manual',
    ...overrides,
  } as unknown as Provider['models'][number];
}

/** Open the editor, fill what `fill` names, press Save, return the PATCH body. */
async function save(
  mdl: Provider['models'][number],
  fill: { free?: boolean; in?: string; out?: string } = {},
) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ModelRow providerId="p1" model={mdl} onChanged={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByLabelText('Edit model'));

  if (fill.free) {
    // A controlled checkbox toggles on click; setting target.checked first
    // just fights React's own value tracking.
    const box = screen.getByLabelText('Free — no per-token charge');
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
  }
  if (fill.in !== undefined) {
    fireEvent.change(screen.getByLabelText('Price per million input tokens'), {
      target: { value: fill.in },
    });
  }
  if (fill.out !== undefined) {
    fireEvent.change(screen.getByLabelText('Price per million output tokens'), {
      target: { value: fill.out },
    });
  }

  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(api.patch).toHaveBeenCalled());
  const call = vi.mocked(api.patch).mock.calls.at(-1);
  return call?.[1] as Record<string, unknown>;
}

beforeEach(() => vi.mocked(api.patch).mockClear());

describe('ModelRow — pricing fields', () => {
  it('reads a stored price back into the fields', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ModelRow providerId="p1" model={model({ priceInPerM: 0.4, priceOutPerM: 1.6 })} onChanged={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByLabelText('Edit model'));
    expect(screen.getByLabelText('Price per million input tokens')).toHaveValue(0.4);
    expect(screen.getByLabelText('Price per million output tokens')).toHaveValue(1.6);
  });

  it('shows a stored zero as 0, not as a blank field', async () => {
    // `value || ''` is the trap here: 0 is this model's real price, and a
    // blank field would silently offer it back to the estimate on next save.
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ModelRow providerId="p1" model={model({ priceInPerM: 0, priceOutPerM: 0 })} onChanged={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByLabelText('Edit model'));
    expect(screen.getByLabelText('Price per million input tokens')).toHaveValue(0);
    expect(screen.getByLabelText('Price per million output tokens')).toHaveValue(0);
  });

  it('sends 0 as a number when the field holds 0', async () => {
    const body = await save(model({ priceInPerM: 0, priceOutPerM: 0 }), {});
    expect(body.priceInPerM).toBe(0);
    expect(body.priceOutPerM).toBe(0);
  });

  it('sends null for a blank field so the estimate still answers', async () => {
    const body = await save(model(), {});
    expect(body.priceInPerM).toBeNull();
    expect(body.priceOutPerM).toBeNull();
    expect(body.free).toBe(false);
  });

  it('sends a typed price as a number', async () => {
    const body = await save(model(), { in: '2.5', out: '10' });
    expect(body.priceInPerM).toBe(2.5);
    expect(body.priceOutPerM).toBe(10);
  });

  it('refuses a negative rather than storing a credit', async () => {
    const body = await save(model(), { in: '-3', out: '' });
    expect(body.priceInPerM).toBeNull();
  });

  it('a free model sends null for both prices even when numbers remain typed', async () => {
    // The stored pair must not be able to contradict the flag: precedence in
    // the estimator would then be deciding between two things the user set.
    const body = await save(model({ priceInPerM: 5, priceOutPerM: 5 }), {
      free: true,
      in: '5',
      out: '5',
    });
    expect(body.free).toBe(true);
    expect(body.priceInPerM).toBeNull();
    expect(body.priceOutPerM).toBeNull();
  });

  it('says plainly what a blank field means, and swaps the note when free', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ModelRow providerId="p1" model={model()} onChanged={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByLabelText('Edit model'));
    const hint = screen.getByTestId('model-price-hint');
    expect(hint).toHaveTextContent('guessing from its model-family table');

    fireEvent.click(screen.getByLabelText('Free — no per-token charge'));
    expect(hint).toHaveTextContent('always reads $0');
    expect(screen.getByLabelText('Price per million input tokens')).toBeDisabled();
  });
});
