import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubagentTimeline, splitSubagentBlocks } from '../SubagentTimeline';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';

vi.mock('@/sections/chat/ChatMarkdown', () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('@/components/chat/ToolCallItem', () => ({
  ToolCallItem: ({ tool }: { tool: { name: string } }) => (
    <div data-testid="tool-row">{tool.name}</div>
  ),
}));

vi.mock('@/components/chat/ThinkingDisclosure', () => ({
  ThinkingDisclosure: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="thinking">{children}</div>
  ),
}));

function makeState(
  overrides: Partial<SubagentBlockState> = {},
): SubagentBlockState {
  return {
    id: 'sb_1',
    jobId: 'j1',
    parentToolId: 'tool-1',
    agentId: 'explore',
    task: 'Investigate bug',
    status: 'running',
    startedAt: Date.now(),
    blocks: [],
    ...overrides,
  };
}

describe('splitSubagentBlocks', () => {
  it('keeps last finalOutput separate from body', () => {
    const blocks = [
      { id: '1', type: 'thinking' as const, content: 'a' },
      { id: '2', type: 'finalOutput' as const, content: 'draft' },
      { id: '3', type: 'toolCall' as const, tool: { id: 't', name: 'read', status: 'done' as const } },
      { id: '4', type: 'finalOutput' as const, content: 'final' },
    ];
    const { bodyBlocks, finalOutput } = splitSubagentBlocks(blocks);
    expect(finalOutput?.content).toBe('final');
    expect(bodyBlocks.map((b) => b.id)).toEqual(['1', '2', '3']);
  });
});

describe('SubagentTimeline', () => {
  it('shows live thinking and tools while running', () => {
    render(
      <SubagentTimeline
        state={makeState({
          status: 'running',
          blocks: [
            { id: 'th', type: 'thinking', content: 'Scanning files' },
            {
              id: 'tc',
              type: 'toolCall',
              tool: {
                id: 't1',
                name: 'grep',
                status: 'running',
                context: 'bug',
              },
            },
          ],
        })}
      />,
    );

    expect(document.querySelector('[data-slot="subagent-timeline-live"]')).toBeTruthy();
    expect(screen.getByTestId('thinking')).toBeInTheDocument();
    expect(screen.getByTestId('tool-row')).toHaveTextContent('grep');
    expect(document.querySelector('[data-slot="subagent-final-output"]')).toBeNull();
  });

  it('shows final response and collapses activity when completed', () => {
    render(
      <SubagentTimeline
        state={makeState({
          status: 'completed',
          finishedAt: Date.now(),
          blocks: [
            { id: 'th', type: 'thinking', content: 'Scanning files' },
            {
              id: 'tc',
              type: 'toolCall',
              tool: {
                id: 't1',
                name: 'grep',
                status: 'done',
              },
            },
            { id: 'fo', type: 'finalOutput', content: 'Bug is in pathsMatch.' },
          ],
        })}
      />,
    );

    expect(document.querySelector('[data-slot="subagent-timeline-done"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="subagent-final-output"]')).toHaveTextContent(
      'Bug is in pathsMatch.',
    );
    // Activity is collapsed by default — tool row not visible until expand.
    expect(screen.queryByTestId('tool-row')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="activity-summary"]')).toBeTruthy();
  });
});
