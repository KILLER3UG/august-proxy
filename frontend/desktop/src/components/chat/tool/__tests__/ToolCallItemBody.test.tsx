import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallItemBody } from '../ToolCallItemBody';
import type { ToolEntry } from '../types';

function makeTool(partial: Partial<ToolEntry> & { name: string }): ToolEntry {
  return { id: 'tool_1', status: 'done', ...partial };
}

describe('ToolCallItemBody — minimal output vs /verbose (plan §4.1/§4.2)', () => {
  it('minimal: read-tool summary never renders inline', () => {
    const { container } = render(
      <ToolCallItemBody
        tool={makeTool({
          name: 'read_file',
          context: JSON.stringify({ path: 'a.py' }),
          summary: 'SECRET_FILE_CONTENT',
        })}
      />,
    );
    expect(container.textContent).not.toContain('SECRET_FILE_CONTENT');
  });

  it('verbose: read-tool summary renders inline', () => {
    const { container } = render(
      <ToolCallItemBody
        verbose
        tool={makeTool({
          name: 'read_file',
          context: JSON.stringify({ path: 'a.py' }),
          summary: 'SECRET_FILE_CONTENT',
        })}
      />,
    );
    expect(container.textContent).toContain('SECRET_FILE_CONTENT');
  });

  it('verbose: generic tool summary renders inline', () => {
    const { container } = render(
      <ToolCallItemBody
        verbose
        tool={makeTool({ name: 'diagnose_proxy', summary: 'RAW_DIAGNOSIS_PAYLOAD' })}
      />,
    );
    expect(container.textContent).toContain('RAW_DIAGNOSIS_PAYLOAD');
  });

  it('memory writes stay expanded even without verbose (edit-class exception)', () => {
    const { container } = render(
      <ToolCallItemBody
        tool={makeTool({ name: 'remember', summary: 'Saved memory entry' })}
      />,
    );
    expect(container.textContent).toContain('Saved memory entry');
  });

  it('verbose: commands render one output pane, never a duplicate result section', () => {
    const { container } = render(
      <ToolCallItemBody
        verbose
        tool={makeTool({
          name: 'run_command',
          context: JSON.stringify({ command: 'ls' }),
          summary: 'file.txt\nExit code: 0',
        })}
      />,
    );
    expect(screen.getByTestId('command-output-pane')).toBeInTheDocument();
    // The raw output appears exactly via the pane's full-output block.
    expect(screen.getByTestId('command-full-output').textContent).toContain('file.txt');
    // No second "result" section duplicating the same text.
    expect(container.querySelectorAll('[data-testid="command-full-output"]')).toHaveLength(1);
  });
});
