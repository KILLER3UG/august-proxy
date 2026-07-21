import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentLaunchList } from '../SubagentLaunchList';
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

function makeAgent(
  overrides: Partial<SubagentBlockState> & Pick<SubagentBlockState, 'jobId'>,
): SubagentBlockState {
  return {
    id: `sb_${overrides.jobId}`,
    parentToolId: 'tool-1',
    agentId: 'explore',
    task: 'Find scroll-down button bug',
    status: 'completed',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    blocks: [],
    ...overrides,
  };
}

describe('SubagentLaunchList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Checked to-do list rows with status under title and model tag', () => {
    // Production passes the session's selected model display name here.
    const currentModelLabel = 'Claude Sonnet 4';
    const agents = [
      makeAgent({ jobId: 'j1', task: 'Find scroll-down button bug', status: 'completed' }),
      makeAgent({ jobId: 'j2', task: 'Find empty folder switch bug', status: 'running' }),
    ];
    render(
      <SubagentLaunchList agents={agents} modelLabel={currentModelLabel} />,
    );

    expect(screen.getByText('Checked to-do list')).toBeInTheDocument();
    expect(screen.getByText('Find scroll-down button bug')).toBeInTheDocument();
    expect(screen.getByText('Find empty folder switch bug')).toBeInTheDocument();
    expect(screen.getAllByText(currentModelLabel)).toHaveLength(2);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('opens inline expanded card on row click', () => {
    const currentModelLabel = 'Claude Sonnet 4';
    const agents = [
      makeAgent({
        jobId: 'j1',
        task: 'Find empty folder switch bug',
        status: 'completed',
        blocks: [
          { id: 't1', type: 'thinking', content: 'Looking around' },
          { id: 'f1', type: 'finalOutput', content: 'Root cause was path mismatch.' },
        ],
      }),
    ];
    render(<SubagentLaunchList agents={agents} modelLabel={currentModelLabel} />);

    fireEvent.click(screen.getByTestId('subagent-launch-row-j1'));
    expect(screen.getByTestId('subagent-expanded-card')).toBeInTheDocument();
    // Title appears in the card header (and may also appear in the prompt box).
    expect(screen.getAllByText('Find empty folder switch bug').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('subagent-detail-modal')).not.toBeInTheDocument();
  });
});
