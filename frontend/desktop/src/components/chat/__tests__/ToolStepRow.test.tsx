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
