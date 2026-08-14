import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/query-client';
import { SubagentLaunchList } from '../SubagentLaunchList';
import type { SubagentBlockState } from '@/sections/chat/chat-stream-manager';

function wrap(ui: React.ReactElement) {
  return <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>;
}

vi.mock('@/sections/chat/ChatMarkdown', () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('@/api/subagents', () => ({
  terminate: vi.fn().mockResolvedValue({ status: 'stopped' }),
  stopAll: vi.fn().mockResolvedValue({ stopped: 0 }),
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
      wrap(
        <SubagentLaunchList agents={agents} modelLabel={currentModelLabel} />,
      ),
    );

    expect(screen.getByText('Workers')).toBeInTheDocument();
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
    render(wrap(<SubagentLaunchList agents={agents} modelLabel={currentModelLabel} />));

    fireEvent.click(screen.getByTestId('subagent-launch-row-j1'));
    expect(screen.getByTestId('subagent-expanded-card')).toBeInTheDocument();
    // Title appears in the card header (and may also appear in the prompt box).
    expect(screen.getAllByText('Find empty folder switch bug').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('subagent-detail-modal')).not.toBeInTheDocument();
  });

  it('renders the stop control for running agents WITHOUT nesting it in the row button (no invalid HTML)', () => {
    // Regression: the row used to be a <button> containing the stop <button>,
    // which React flagged ("<button> cannot contain a nested <button>").
    const agents = [
      makeAgent({ jobId: 'j1', task: 'Find scroll-down button bug', status: 'running' }),
    ];
    render(wrap(<SubagentLaunchList agents={agents} />));

    const stop = screen.getByTestId('stop-launch-j1');
    expect(stop).toBeInTheDocument();
    // The row is a div[role=button] — a nested <button> inside it is valid.
    const row = screen.getByTestId('subagent-launch-row-j1');
    expect(row.tagName).toBe('DIV');
    expect(row).toHaveAttribute('role', 'button');
    // Clicking stop must NOT open the expanded card (stopPropagation).
    fireEvent.click(stop);
    expect(screen.queryByTestId('subagent-expanded-card')).not.toBeInTheDocument();
    // Clicking the row still opens the card.
    fireEvent.click(row);
    expect(screen.getByTestId('subagent-expanded-card')).toBeInTheDocument();
  });
});
