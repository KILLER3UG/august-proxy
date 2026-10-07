/* ── ModelPickerDropdown — the ordering the shared comparator promises ─────
 * compareModelsRanked's own docstring says it exists so "pinning a model has the
 * same effect everywhere", used by the composer dropdown and the model settings
 * lists. This component sorted by isFree-then-name and never read `pinned`, so a
 * pinned model lost to a free one inside the same provider — the opposite of
 * what pinning means.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelPickerDropdown } from '../ModelPickerDropdown';
import type { AggregatedModel } from '@/api/api-client';

const MODELS: AggregatedModel[] = [
  // Same provider, so the group cannot hide the ordering choice. `pinned` is
  // also NOT free, so the old free-first sort puts Haiku first by two rules.
  { id: 'anthropic/claude-haiku-4', provider: 'anthropic', name: 'Claude Haiku 4', isFree: true },
  {
    id: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    pinned: true,
  },
  { id: 'google/gemini-pro', provider: 'google', name: 'Gemini Pro', isFree: true },
];

beforeEach(() => vi.clearAllMocks());

const openList = () =>
  fireEvent.click(screen.getByRole('button', { name: /select model/i }));

function rowOrder(): string[] {
  // Rows render the id-derived name ("Sonnet 5"), not the API's `name` field,
  // so the matcher is against what is actually on screen.
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((t) => /Sonnet 5|Haiku 4|Gemini pro/.test(t))
    .map((t) => (t.includes('Sonnet') ? 'sonnet' : t.includes('Haiku') ? 'haiku' : 'gemini'));
}

describe('ModelPickerDropdown', () => {
  it('orders by the shared ranking, so a pinned model beats a free one', async () => {
    render(<ModelPickerDropdown models={MODELS} value="" onChange={vi.fn()} />);
    openList();
    await waitFor(() => expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument());

    const anthropic = rowOrder().filter((r) => r === 'sonnet' || r === 'haiku');
    expect(anthropic).toEqual(['sonnet', 'haiku']);
  });

  it('does not repeat the group header inside every row', async () => {
    render(<ModelPickerDropdown models={MODELS} value="" onChange={vi.fn()} />);
    openList();
    await waitFor(() => expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument());

    // Provider is the sticky group header; the id-derived tag used to print it
    // again, giving "Sonnet 5anthropic—", and the context column rendered an
    // em dash when the model has no contextWindow.
    const row = screen.getAllByRole('button').find((b) => b.textContent?.includes('Sonnet 5'));
    expect(row?.textContent).toBe('Sonnet 5');
    expect(document.body.textContent).not.toContain('5anthropic');
    expect(document.body.textContent).not.toContain('—');
  });

  it('searches across providers and selects with the provider it came from', async () => {
    const onChange = vi.fn();
    render(<ModelPickerDropdown models={MODELS} value="" onChange={onChange} />);
    openList();
    const input = await screen.findByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: 'sonnet' } });
    await waitFor(() => expect(rowOrder()).toHaveLength(1));

    fireEvent.click(screen.getByText(/Sonnet 5/));
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-5', 'anthropic');
  });
});
