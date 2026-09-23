import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CrashCard, ErrorBoundary } from '../ErrorBoundary';

function Boom(): never {
  throw new Error('render failed');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('replaces a render failure with a recoverable alert', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ErrorBoundary><Boom /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText('August ran into a problem')).toBeTruthy();
    expect(screen.getByText('render failed')).toBeTruthy();
    expect(screen.getByText('Your work is still stored locally. Reloading may restore the last session.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload August' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy error' })).toBeTruthy();
  });

  it('copies the technical details and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CrashCard error={new Error('copy failed')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('copy failed'));
  });
});
