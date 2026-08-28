import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  applyCarriageReturns,
  formatCommandOutputForDisplay,
  CommandOutputPane,
} from '../CommandOutputPane';

describe('applyCarriageReturns', () => {
  it('keeps the last progress segment on a line', () => {
    const raw = 'Downloading a\rDownloading b (50%)\rDownloading b (100%)\nDone\n';
    expect(applyCarriageReturns(raw)).toBe('Downloading b (100%)\nDone\n');
  });
});

describe('formatCommandOutputForDisplay', () => {
  it('strips sandbox tags and exit code trailer', () => {
    const raw =
      '[sandbox:soft|sandboxed] Looking in indexes: https://example.com\nExit code: 1';
    const out = formatCommandOutputForDisplay(raw);
    expect(out.body).toBe('Looking in indexes: https://example.com');
    expect(out.exitCode).toBe(1);
    expect(out.failed).toBe(true);
  });

  it('softens STDERR header', () => {
    const out = formatCommandOutputForDisplay('ok\nSTDERR:\nbad');
    expect(out.body).toContain('Errors:');
    expect(out.body).not.toContain('STDERR:');
  });
});

describe('CommandOutputPane — minimal output (plan §4.1)', () => {
  const PYTEST_FAIL = [
    'collected 2 items',
    'test_a.py::test_ok PASSED',
    'test_a.py::test_bad FAILED',
    'AssertionError: expected 200, got 500',
    '= 1 failed, 1 passed in 0.42s =',
    'Exit code: 1',
  ].join('\n');

  it('success renders command + green pill only — no output body', () => {
    const { container } = render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'ls -la' })}
        summary={'file.txt\nother.txt\nExit code: 0'}
        status="done"
      />,
    );
    expect(screen.getByTestId('command-status-pill').textContent).toBe('Done');
    expect(container.textContent).toContain('ls -la');
    // Raw stdout never streams into the transcript on success.
    expect(container.textContent).not.toContain('file.txt');
    expect(screen.queryByTestId('command-error-line')).toBeNull();
    expect(screen.queryByTestId('command-output-toggle')).toBeNull();
  });

  it('failure shows one red digest line; full output behind the click', () => {
    render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'python -m pytest -x' })}
        summary={PYTEST_FAIL}
        status="error"
      />,
    );
    const pill = screen.getByTestId('command-status-pill');
    expect(pill.textContent).toContain('Failed');
    // Structured digest — the pytest verdict, not the raw head.
    expect(screen.getByTestId('command-error-line').textContent).toBe(
      '1 failed, 1 passed in 0.42s',
    );
    expect(screen.queryByTestId('command-full-output')).toBeNull();

    fireEvent.click(screen.getByTestId('command-output-toggle'));
    const full = screen.getByTestId('command-full-output');
    expect(full.textContent).toContain('AssertionError: expected 200, got 500');
    expect(full.textContent).toContain('test_a.py::test_ok PASSED');

    // Collapses again.
    fireEvent.click(screen.getByTestId('command-output-toggle'));
    expect(screen.queryByTestId('command-full-output')).toBeNull();
  });

  it('running shows the running pill without streaming raw output', () => {
    const { container } = render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'npm test' })}
        preview={'partial output…'}
        status="running"
      />,
    );
    expect(screen.getByTestId('command-status-pill').textContent).toBe('Running');
    expect(container.textContent).not.toContain('partial output');
    expect(screen.queryByTestId('command-error-line')).toBeNull();
  });
});

describe('CommandOutputPane — /verbose (plan §4.2)', () => {
  it('verbose renders full output inline on success — no toggle needed', () => {
    render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'ls -la' })}
        summary={'file.txt\nother.txt\nExit code: 0'}
        status="done"
        verbose
      />,
    );
    const full = screen.getByTestId('command-full-output');
    expect(full.textContent).toContain('file.txt');
    expect(full.textContent).toContain('other.txt');
    // The opt-in toggle is pointless when output is already shown.
    expect(screen.queryByTestId('command-output-toggle')).toBeNull();
  });

  it('verbose shows full output on failure without the click', () => {
    render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'python -m pytest -x' })}
        summary={'boom\nExit code: 1'}
        status="error"
        verbose
      />,
    );
    expect(screen.getByTestId('command-full-output').textContent).toContain('boom');
    expect(screen.queryByTestId('command-output-toggle')).toBeNull();
  });

  it('verbose streams the live preview of a running command', () => {
    render(
      <CommandOutputPane
        toolName="run_command"
        context={JSON.stringify({ command: 'npm test' })}
        preview={'partial output…'}
        status="running"
        verbose
      />,
    );
    expect(screen.getByTestId('command-full-output').textContent).toContain(
      'partial output',
    );
  });
});
