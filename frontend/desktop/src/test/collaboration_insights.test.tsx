import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CollaborationInsights } from '@/components/chat/CollaborationInsights';

vi.mock('@/hooks/useLearningData', () => ({
  useLearningData: () => ({
    data: {
      heuristics: [],
      heuristicCount: 0,
      coreFacts: ['Prefers concise answers'],
      userProfile: null,
      autoMemories: [{ id: 1, key: 'k', content: 'User works on august-proxy', importance: 0.8 }],
      activeProjects: [],
      currentContext: '',
      sleepCycle: { lastRunAt: null, lastMerged: 0, lastPromoted: 0, lastDeleted: 0 },
      deltaEngine: { consentGranted: false, queueSize: 0, lastFlushAt: null },
      pendingSkills: [
        { id: 9, name: 'deploy-desktop', description: 'Ship desktop builds safely' },
      ],
    },
  }),
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CollaborationInsights', () => {
  beforeEach(() => {
    window.localStorage.removeItem('august.collaboration-insights.dismissed');
  });

  it('shows evolving skills banner and not persistent memory', () => {
    wrap(<CollaborationInsights />);
    expect(screen.getByTestId('evolving-skills-banner').textContent).toMatch(/Evolving skills/i);
    expect(screen.getAllByText(/deploy-desktop/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('persistent-memory-banner')).toBeNull();
    expect(screen.queryByText(/Persistent memory/i)).toBeNull();
  });

  it('dismisses the banner for the current pending-skill set', () => {
    wrap(<CollaborationInsights />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss evolving skills notification' }));
    expect(screen.queryByTestId('evolving-skills-banner')).toBeNull();
    expect(window.localStorage.getItem('august.collaboration-insights.dismissed')).toBe('9:deploy-desktop');
  });
});
