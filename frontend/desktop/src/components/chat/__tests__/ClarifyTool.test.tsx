import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarifyTool } from '@/components/chat/ClarifyTool';

vi.mock('@/sections/chat/ChatMarkdown', () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="md-preview">{content}</div>,
}));

describe('ClarifyTool previews', () => {
  it('a pick with previews focuses the preview and defers submit until confirm', () => {
    const onSubmit = vi.fn();
    render(
      <ClarifyTool
        payload={{
          questions: [
            {
              question: 'Which layout?',
              choices: ['Ring', 'Donut'],
              previews: ['ring geometry here', 'donut geometry here'],
            },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText('Donut'));
    expect(onSubmit).not.toHaveBeenCalled(); // focus, not submit
    expect(screen.getByTestId('md-preview').textContent).toContain('donut geometry');
    fireEvent.click(screen.getByText('Use this'));
    expect(onSubmit).toHaveBeenCalledWith('Donut');
  });

  it('without previews a single-select pick submits immediately (legacy behavior)', () => {
    const onSubmit = vi.fn();
    render(
      <ClarifyTool
        payload={{ questions: [{ question: 'Pick one', choices: ['A', 'B'] }] }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText('B'));
    expect(onSubmit).toHaveBeenCalledWith('B');
  });

  it('multi-select ignores previews (focus-then-confirm is single-select only)', () => {
    const onSubmit = vi.fn();
    render(
      <ClarifyTool
        payload={{
          questions: [
            { question: 'Pick many', choices: ['A', 'B'], multiSelect: true, previews: ['pa', 'pb'] },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText('A'));
    expect(screen.queryByTestId('clarify-preview')).toBeNull();
  });
});
