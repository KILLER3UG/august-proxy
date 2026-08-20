import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunTelemetryBar, formatDuration, formatTokensPerSec } from '../RunTelemetryBar';

describe('RunTelemetryBar', () => {
  it('formats duration correctly', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(3200)).toBe('3.2s');
  });

  it('formats tokens per second correctly', () => {
    expect(formatTokensPerSec(100, 1000)).toBe('100.0 t/s');
    expect(formatTokensPerSec(50, 2000)).toBe('25.0 t/s');
  });

  it('renders telemetry metrics and toggles waterfall', () => {
    const toolTimings = [
      { id: 't1', name: 'run_command', durationMs: 120, startedAtMs: 1000, blocked: false },
      { id: 't2', name: 'web_search', durationMs: 0, startedAtMs: 1150, blocked: true },
    ];

    render(
      <RunTelemetryBar
        cacheHitRate={0.85}
        ttftMs={230}
        outputTokens={250}
        durationMs={2000}
        roundCount={3}
        toolTimings={toolTimings}
      />
    );

    expect(screen.getByTestId('run-telemetry-bar')).toBeInTheDocument();
    expect(screen.getByText('85% cache')).toBeInTheDocument();
    expect(screen.getByText('230ms TTFT')).toBeInTheDocument();
    expect(screen.getByText('125.0 t/s')).toBeInTheDocument();
    expect(screen.getByText('3 rounds')).toBeInTheDocument();
    expect(screen.getByText('2 tools')).toBeInTheDocument();

    // Waterfall is collapsed initially
    expect(screen.queryByTestId('telemetry-waterfall')).not.toBeInTheDocument();

    // Toggle waterfall
    fireEvent.click(screen.getByTestId('telemetry-waterfall-toggle'));
    expect(screen.getByTestId('telemetry-waterfall')).toBeInTheDocument();
    expect(screen.getByText('run_command')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(screen.getByText('120ms')).toBeInTheDocument();
  });
});
