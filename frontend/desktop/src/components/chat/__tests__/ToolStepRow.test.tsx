import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolStepRow } from '../ToolStepRow';
import type { ToolEntry } from '@/components/chat/ToolCallItem';

function makeTool(partial: Partial<ToolEntry> & { name: string }): ToolEntry {
  return {
    id: 'tool_1',
    status: 'done',
    ...partial,
  };
}

describe('ToolStepRow — Task block', () => {
  it('edit tools render basename pill + diff stat + Done row, never full paths', () => {
    const tool = makeTool({
      name: 'edit_file',
      status: 'done',
      context: JSON.stringify({
        path: 'C:/Dev/august-proxy/backend/app/users.csv',
        'old_string': 'a\nb',
        'new_string': 'a\nb\nc\nd',
      }),
    });

    const { container } = render(
      <ToolStepRow
        tool={tool}
        label="Edited users.csv"
        expanded
        onToggle={() => {}}
      />,
    );

    // Filename pill carries the basename only.
    expect(screen.getByText('users.csv')).toBeInTheDocument();
    expect(container.textContent).not.toContain('C:/Dev');
    expect(container.textContent).not.toContain('august-proxy');

    // Diff stat: +2 -0, additions green / deletions red.
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('-0', { exact: false })).toBeInTheDocument();

    // Completed edit run closes with a bare Done row.
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('progress entries render as per-file Task rows with basenames', () => {
    const tool = makeTool({ name: 'read_file', status: 'running' });

    render(
      <ToolStepRow
        tool={tool}
        label="Reading config.yaml"
        expanded
        onToggle={() => {}}
        progress={[
          { path: '/etc/august/config.yaml', status: 'read' },
          { path: '/etc/august/other.toml', status: 'reading' },
        ]}
      />,
    );

    expect(screen.getByText('config.yaml')).toBeInTheDocument();
    expect(screen.getByText('other.toml')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Reading')).toBeInTheDocument();
  });

  it('does not force-collapse when the tool completes', () => {
    const running = makeTool({
      name: 'write_file',
      status: 'running',
      context: JSON.stringify({ path: 'a.ts', content: 'x' }),
    });

    const { rerender } = render(
      <ToolStepRow
        tool={running}
        label="Writing a.ts"
        expanded // parent derives open while running
        onToggle={() => {}}
      />,
    );
    const toggle = screen.getByRole('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Turn finishes: parent default flips to collapsed, but the block must
    // stay however the user left it (spec: no force-collapse on completion).
    rerender(
      <ToolStepRow
        tool={{ ...running, status: 'done' }}
        label="Wrote a.ts"
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');

    // User collapse is respected.
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('reports toggles to the parent with the next open value', () => {
    const onToggle = vi.fn();
    const tool = makeTool({
      name: 'diagnose_proxy',
      status: 'done',
      summary: '{"ok":true}',
    });
    render(
      <ToolStepRow
        tool={tool}
        label="Diagnosed proxy"
        expanded={false}
        onToggle={onToggle}
      >
        <div>response body</div>
      </ToolStepRow>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe('ToolStepRow — minimal-output policy (plan §4.1)', () => {
  it('settled read rows are header-only: no chevron, toggle disabled', () => {
    const tool = makeTool({
      name: 'read_file',
      status: 'done',
      context: JSON.stringify({ path: 'a.py' }),
      summary: 'x'.repeat(300),
    });
    render(
      <ToolStepRow tool={tool} label="Read a.py" expanded={false} onToggle={() => {}}>
        <div>should never render</div>
      </ToolStepRow>,
    );
    const toggle = screen.getByRole('button');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('should never render')).toBeNull();
  });

  it('successful command rows are header-only', () => {
    const tool = makeTool({
      name: 'run_command',
      status: 'done',
      context: JSON.stringify({ command: 'ls' }),
      summary: 'file.txt',
    });
    render(
      <ToolStepRow
        tool={tool}
        label="Ran: ls"
        isCommand
        expanded={false}
        onToggle={() => {}}
      >
        <div>output body</div>
      </ToolStepRow>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.queryByText('output body')).toBeNull();
  });

  it('failed command rows show one inline error line and stay expandable', () => {
    const tool = makeTool({
      name: 'run_command',
      status: 'error',
      context: JSON.stringify({ command: 'python -m pytest' }),
      error: 'AssertionError: expected 200, got 500',
    });
    render(
      <ToolStepRow
        tool={tool}
        label="Ran: python -m pytest"
        isCommand
        expanded={false}
        onToggle={() => {}}
      >
        <div>full output</div>
      </ToolStepRow>,
    );
    const errLine = screen.getByTestId('tool-error-line');
    expect(errLine.textContent).toBe('AssertionError: expected 200, got 500');
    const toggle = screen.getByRole('button');
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(screen.getByText('full output')).toBeInTheDocument();
  });

  it('read duration shows only above 1s', () => {
    const fast = makeTool({
      name: 'read_file',
      status: 'done',
      context: JSON.stringify({ path: 'a.py' }),
      duration: 400,
    });
    const { unmount } = render(
      <ToolStepRow tool={fast} label="Read a.py" expanded={false} onToggle={() => {}} />,
    );
    expect(screen.queryByTestId('tool-read-duration')).toBeNull();
    unmount();

    const slow = makeTool({
      name: 'read_file',
      status: 'done',
      context: JSON.stringify({ path: 'big.py' }),
      duration: 1400,
    });
    render(
      <ToolStepRow tool={slow} label="Read big.py" expanded={false} onToggle={() => {}} />,
    );
    expect(screen.getByTestId('tool-read-duration').textContent).toBe('1.4s');
  });
});
