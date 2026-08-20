import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SkillSuggestionChip } from '../SkillSuggestionChip';
import * as subagents from '@/api/subagents';
import * as apiClient from '@/api/api-client';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/api/subagents', () => ({
  previewSkillFromEpisode: vi.fn(),
  saveSkillFromEpisode: vi.fn(),
}));

describe('SkillSuggestionChip', () => {
  let messageHandler: ((ev: MessageEvent) => void) | null = null;
  const mockClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    vi.spyOn(apiClient, 'openBrainEventStream').mockImplementation(() => {
      const mockEs = {
        set onmessage(handler: (ev: MessageEvent) => void) {
          messageHandler = handler;
        },
        close: mockClose,
      } as unknown as EventSource;
      return mockEs;
    });
  });

  it('renders suggestion on skill_suggestion event and handles saving', async () => {
    (subagents.previewSkillFromEpisode as any).mockResolvedValue({
      name: 'lane-fix-build',
      slug: 'fix-build',
      description: 'Fix build errors',
      body: '# fix-build\n\n## Procedure\nRun npm test',
      trigger: 'fix-build',
      category: 'harness',
      createdBy: 'user',
      seq: 1,
    });
    (subagents.saveSkillFromEpisode as any).mockResolvedValue({ name: 'lane-fix-build' });

    render(<SkillSuggestionChip currentSessionId="sess-1" />);

    expect(screen.queryByTestId('skill-suggestion-chip')).not.toBeInTheDocument();

    // Trigger SSE event
    act(() => {
      messageHandler?.({
        data: JSON.stringify({
          category: 'skill_suggestion',
          layer: 'workstreams.episode_completed',
          summary: 'Suggest skill: lane-fix-build',
          meta: {
            workstream: 'fix-build',
            suggestedName: 'lane-fix-build',
            sessionId: 'sess-1',
            seq: 1,
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(screen.getByTestId('skill-suggestion-chip')).toBeInTheDocument();
    });

    expect(screen.getByText('fix-build')).toBeInTheDocument();

    // Quick save
    fireEvent.click(screen.getByTestId('skill-quick-save-btn'));

    await waitFor(() => {
      expect(subagents.saveSkillFromEpisode).toHaveBeenCalledWith('sess-1', 'fix-build', 1);
      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });
  });
});
