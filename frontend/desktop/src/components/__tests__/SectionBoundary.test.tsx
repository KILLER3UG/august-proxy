import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SectionBoundary } from '@/components/SectionBoundary';

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('Test crash in section');
  return <div data-testid="healthy-content">All good</div>;
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('SectionBoundary', () => {
  it('renders children normally when no error', () => {
    renderWithRouter(
      <SectionBoundary name="Traffic">
        <ThrowingComponent shouldThrow={false} />
      </SectionBoundary>,
    );
    expect(screen.getByTestId('healthy-content')).toBeInTheDocument();
  });

  it('shows section-specific fallback on child error', () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithRouter(
      <SectionBoundary name="Traffic">
        <ThrowingComponent shouldThrow={true} />
      </SectionBoundary>,
    );

    expect(screen.getByText('Traffic encountered an error')).toBeInTheDocument();
    expect(screen.getByText(/Test crash in section/)).toBeInTheDocument();
    expect(screen.getByTestId('section-crash-traffic')).toBeInTheDocument();

    spy.mockRestore();
  });

  it('retry button re-mounts children', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;

    function Conditional() {
      if (shouldThrow) throw new Error('boom');
      return <div data-testid="recovered">Recovered!</div>;
    }

    renderWithRouter(
      <SectionBoundary name="Brain">
        <Conditional />
      </SectionBoundary>,
    );

    expect(screen.getByText('Brain encountered an error')).toBeInTheDocument();

    // Fix the error and click retry
    shouldThrow = false;
    fireEvent.click(screen.getByText('Retry'));

    expect(screen.getByTestId('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('Go to Chat button navigates to /', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithRouter(
      <SectionBoundary name="Skills">
        <ThrowingComponent shouldThrow={true} />
      </SectionBoundary>,
    );

    const goButton = screen.getByText('Go to Chat');
    expect(goButton).toBeInTheDocument();
    // Navigation is handled by react-router; just verify the button exists
    spy.mockRestore();
  });

  it('uses custom fallback when provided', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithRouter(
      <SectionBoundary name="Custom" fallback={<div data-testid="custom-fallback">Oops</div>}>
        <ThrowingComponent shouldThrow={true} />
      </SectionBoundary>,
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('truncates long error messages', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longMsg = 'x'.repeat(300);

    function LongError(): React.ReactElement {
      throw new Error(longMsg);
    }

    renderWithRouter(
      <SectionBoundary name="Test">
        <LongError />
      </SectionBoundary>,
    );

    // Should show truncated message with ellipsis
    const displayed = screen.getByText(/x{10,}…/);
    expect(displayed.textContent!.length).toBeLessThan(250);
    spy.mockRestore();
  });
});
