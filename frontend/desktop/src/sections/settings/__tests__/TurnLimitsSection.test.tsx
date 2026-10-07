/* Turn Limits — the panel for the turn bounds the backend has always honoured
 * and the app never exposed.
 *
 * The knobs existed in `allowedKeys`/`fieldTable` and were read by the loop, but
 * nothing rendered them: `maxWorkbenchToolLoops` existed in the TS client as a
 * type only, and the runaway backstop's two keys were not even settable through
 * the API. So this file pins two things — the panel renders every bound and can
 * save it under the exact backend key, and it never shows a limit the backend
 * did not return. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '@/api/client';
import { TurnLimitsSection } from '../TurnLimitsSection';

const KEYS = [
  'maxWorkbenchToolLoops',
  'budgetSoftUsd',
  'budgetSoftTokens',
  'budgetWallClockSec',
  'runawayNudgeRounds',
  'runawayStopRounds',
] as const;

function offConfig(): Record<string, number> {
  return Object.fromEntries(KEYS.map((k) => [k, 0]));
}

let getSpy: MockInstance;
let putSpy: MockInstance;

beforeEach(() => {
  vi.restoreAllMocks();
  getSpy = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/api/brain/config') {
      return { source: 'fallback', config: offConfig(), defaults: offConfig() };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  putSpy = vi.spyOn(api, 'put').mockImplementation(async () => ({ ok: true }));
});

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TurnLimitsSection />
    </QueryClientProvider>,
  );
}

describe('TurnLimitsSection', () => {
  it('renders a control for every turn bound, each reading "off" by default', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limit-maxWorkbenchToolLoops')).toBeTruthy());

    for (const key of KEYS) {
      expect(screen.getByTestId(`turn-limit-${key}`), `missing a row for ${key}`).toBeTruthy();
    }
    // The shipped state is unbounded everywhere — the panel must say "off"
    // rather than showing a bare 0 that reads like a real limit.
    expect(screen.getAllByText('off').length).toBe(KEYS.length);
  });

  it('saves an edited value under the exact backend key', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limit-maxWorkbenchToolLoops')).toBeTruthy());

    const input = screen.getByTestId('turn-limit-input-maxWorkbenchToolLoops');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][0]).toBe('/api/brain/config');
    expect(putSpy.mock.calls[0][1]).toEqual({ maxWorkbenchToolLoops: 120 });
  });

  it('clamps an out-of-range value instead of sending it', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limit-budgetSoftUsd')).toBeTruthy());

    fireEvent.change(screen.getByTestId('turn-limit-input-budgetSoftUsd'), {
      target: { value: '999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toEqual({ budgetSoftUsd: 10000 });
  });

  it('only sends the keys that actually changed', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limit-runawayStopRounds')).toBeTruthy());

    fireEvent.change(screen.getByTestId('turn-limit-input-runawayStopRounds'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(Object.keys(putSpy.mock.calls[0][1] as object)).toEqual(['runawayStopRounds']);
  });

  it('says it changed nothing when the read fails, rather than inventing limits', async () => {
    getSpy.mockImplementation((async () => {
      throw new Error('ECONNREFUSED');
    }) as never);

    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limits-error')).toBeTruthy());
    // The failure path must not render invented numbers as saved truth.
    expect(screen.queryByTestId('turn-limit-maxWorkbenchToolLoops')).toBeNull();
  });

  it('explains the runaway backstop as the only bound on a varying turn', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('turn-limit-runawayStopRounds')).toBeTruthy());
    expect(screen.getByText(/stall detection deliberately resets/i)).toBeTruthy();
  });
});
