/* ── ModelPickerDropdown — the ordering the shared comparator promises ─────
 * compareModelsRanked's own docstring says it exists so "pinning a model has the
 * same effect everywhere", used by the composer dropdown and the model settings
 * lists. This component sorted by isFree-then-name and never read `pinned`, so a
 * pinned model lost to a free one inside the same provider — the opposite of
 * what pinning means.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// The trigger's accessible name changes once a model is selected (it announces
// the model, which is the point of dropping the native tooltip), so open by the
// popup role rather than by label text.
const openList = () =>
  fireEvent.click(screen.getByRole('button', { name: /select model|^model:/i }));

function rowOrder(): string[] {
  // role="option" since the list became a real listbox; the labels are the
  // id-derived names ("Sonnet 5"), not the API `name` field.
  return screen
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
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
    const row = screen.getAllByRole('option').find((o) => o.textContent?.includes('Sonnet 5'));
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

  it('selects with the keyboard, which the mouse-only list never could', async () => {
    const onChange = vi.fn();
    render(<ModelPickerDropdown models={MODELS} value="" onChange={onChange} />);
    openList();
    await screen.findByPlaceholderText(/search models/i);

    // Pinned Sonnet is first in the shared ranking; one ArrowDown steps to Haiku.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('anthropic/claude-haiku-4', 'anthropic');

    // Escape must reset, not just hide, or a reopen shows a filter with no rows.
    // Assert the component's own state rather than the node: AnimatePresence
    // keeps the panel mounted through its exit animation, so a null-DOM check
    // here would be testing framer-motion, not the close.
    fireEvent.keyDown(document, { key: 'Escape' });
    const trigger = screen.getByRole('button', { name: /select model|^model:/i });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    // And the cursor is back at the head, so the next open starts clean.
    fireEvent.click(trigger);
    await screen.findByPlaceholderText(/search models/i);
    expect(rowOrder()[0]).toBe('sonnet');
  });

  it('exposes the list as a listbox so a screen reader gets options and state', async () => {
    render(<ModelPickerDropdown models={MODELS} value="anthropic/claude-haiku-4" onChange={vi.fn()} />);
    openList();
    const listbox = await screen.findByRole('listbox', { name: /models/i });
    expect(listbox).toBeInTheDocument();
    const options = within(listbox).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Sonnet 5',
      'Haiku 4',
      'Gemini pro',
    ]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });
});
