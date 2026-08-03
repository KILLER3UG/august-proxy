/* v3 — Brain dashboard LearningTab + SystemHealthTab */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { BrainDashboard } from '@/sections/brain/BrainDashboard';
import { JourneyTab } from '@/sections/brain/JourneyTab';
import * as apiClient from '@/api/client';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
}

function mockApiGetSequence(responses: Array<unknown>) {
  let i = 0;
  return vi.spyOn(apiClient.api, 'get').mockImplementation(() => {
    const data = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(data);
  });
}

function mockApiPostSequence(responses: Array<unknown>) {
  let i = 0;
  return vi.spyOn(apiClient.api, 'post').mockImplementation(() => {
    const data = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(data);
  });
}

const FULL_LEARNING = {
  heuristics: [
    { id: 1, rule: 'Use Yarn', source: 'manual', category: 'build', confidence: 0.8, createdAt: '2026-06-29' },
    { id: 2, rule: 'Prefer tabs', source: 'local-diff', category: 'style', createdAt: '2026-06-29' },
  ],
  heuristicCount: 2,
  coreFacts: { codeStyle: 'spaces' },
  userProfile: null,
  autoMemories: [{ id: 1, key: 'jwt-fix', content: 'JWT expiry bug', importance: 0.8 }],
  activeProjects: [{ name: 'august-proxy', path: 'C:\\Dev\\august-proxy' }],
  currentContext: 'Working on automations',
  sleepCycle: { lastRunAt: '2026-06-29T10:00:00Z', lastMerged: 2, lastPromoted: 1, lastDeleted: 0 },
  deltaEngine: { consentGranted: false, queueSize: 0, lastFlushAt: null },
  pendingSkills: [{ id: 1, name: 'jwtDebugFlow', description: 'Debug JWT', triggerText: 'auth error' }],
};

const FULL_HEALTH = {
  phases: [
    { layer: 'Phase 4 — Learned Heuristics', flag: 'heuristics', flagValue: true, status: 'on & healthy', detail: '12 active heuristics', lastCheckAt: '2026-06-29T10:00:00Z' },
    { layer: 'Phase 10 — Blackboard', flag: 'blackboard', flagValue: true, status: 'on & failing', detail: '3 notes stale', lastCheckAt: '2026-06-29T10:00:01Z' },
  ],
};

describe('v3 — LearningTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders heuristics with source badges', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('Use Yarn')).toBeTruthy();
      expect(screen.getByText('manual')).toBeTruthy();
      expect(screen.getByText('local-diff')).toBeTruthy();
    });
  });

  it('renders confidence badges on scored heuristics', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByTestId('heuristic-confidence-1').textContent).toBe('80%');
    });
    // Unscored heuristics render no badge.
    expect(screen.queryByTestId('heuristic-confidence-2')).toBeNull();
  });

  it('renders auto-memories', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/JWT expiry bug/)).toBeTruthy();
    });
  });

  it('renders sleep cycle stats', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/Last run/)).toBeTruthy();
      expect(screen.getByText('Merged')).toBeTruthy();
      expect(screen.getByText('Promoted')).toBeTruthy();
    });
  });

  it('renders pending skills', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('jwtDebugFlow')).toBeTruthy();
    });
  });

  it('renders the user profile summary when present', async () => {
    const learning = {
      ...FULL_LEARNING,
      userProfile: { summary: 'Name: Ada\nStack: Python, FastAPI', facts: [] },
    };
    mockApiGetSequence([learning]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/Name: Ada/)).toBeTruthy();
    });
  });

  it('shows an empty-state when no profile exists yet', async () => {
    mockApiGetSequence([FULL_LEARNING]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/No profile yet/)).toBeTruthy();
    });
  });

  it('deletes an auto-memory via the delete button', async () => {
    const del = vi.spyOn(apiClient.api, 'delete').mockResolvedValue({ ok: true });
    mockApiGetSequence([FULL_LEARNING, { ...FULL_LEARNING, autoMemories: [] }]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByTestId('delete-memory-1')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('delete-memory-1'));
    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('/api/memory/auto/1');
    });
    confirmSpy.mockRestore();
  });

  it('shows a pinned badge on pinned memories', async () => {
    const learning = {
      ...FULL_LEARNING,
      autoMemories: [
        { id: 2, key: 'pin-this', content: 'Pinned fact', importance: 0.9, pinned: 1 },
      ],
    };
    mockApiGetSequence([learning]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('pin-this')).toBeTruthy();
      expect(screen.getByLabelText('pinned')).toBeTruthy();
    });
  });

  it('expands a pending skill into a diff preview', async () => {
    const draft = { name: 'jwtDebugFlow', body: 'Debug JWT expiry.', existingBody: 'The old body.' };
    mockApiGetSequence([FULL_LEARNING, draft]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByTestId('preview-skill-jwtDebugFlow')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('preview-skill-jwtDebugFlow'));
    await waitFor(() => {
      expect(screen.getByText(/Debug JWT expiry/)).toBeTruthy();
      expect(screen.getByText(/The old body/)).toBeTruthy();
    });
  });

  it('shows a loading state while the draft is fetched', async () => {
    const draft = { name: 'jwtDebugFlow', body: 'Debug JWT expiry.', existingBody: null };
    mockApiGetSequence([FULL_LEARNING, draft]);
    renderWithQuery(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByTestId('preview-skill-jwtDebugFlow')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('preview-skill-jwtDebugFlow'));
    expect(screen.getByText(/Loading draft/)).toBeTruthy();
  });
});

describe('v3 — JourneyTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders grouped timeline events', async () => {
    mockApiGetSequence([
      {
        items: [
          { id: 2, timestamp: '2026-08-03 10:00:00', sessionId: 'wb_1', eventSummary: 'User asked: fix CI', category: 'workbench' },
          { id: 1, timestamp: '2026-08-03 09:00:00', sessionId: null, eventSummary: 'Memory cap active: pruned 3 memories', category: 'memory' },
        ],
        count: 2,
      },
    ]);
    renderWithQuery(<JourneyTab />);
    await waitFor(() => {
      expect(screen.getByText(/fix CI/)).toBeTruthy();
      expect(screen.getByText(/pruned 3 memories/)).toBeTruthy();
      expect(screen.getByText('workbench')).toBeTruthy();
      expect(screen.getByText('memory')).toBeTruthy();
    });
  });

  it('renders an empty state', async () => {
    mockApiGetSequence([{ items: [], count: 0 }]);
    renderWithQuery(<JourneyTab />);
    await waitFor(() => {
      expect(screen.getByText(/No timeline entries yet/)).toBeTruthy();
    });
  });
});

describe('v3 — SystemHealthTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a layer row with detail', async () => {
    mockApiGetSequence([FULL_HEALTH]);
    renderWithQuery(<SystemHealthTab />);
    await waitFor(() => {
      expect(screen.getByText('Phase 4 — Learned Heuristics')).toBeTruthy();
      expect(screen.getByText('on & healthy')).toBeTruthy();
      expect(screen.getByText('12 active heuristics')).toBeTruthy();
    });
  });

  it('shows failing detail when a layer is failing', async () => {
    mockApiGetSequence([FULL_HEALTH]);
    renderWithQuery(<SystemHealthTab />);
    await waitFor(() => {
      expect(screen.getByText('3 notes stale')).toBeTruthy();
    });
  });
});

describe('v3 — BrainDashboard tab switching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('switches between Learning and System Health tabs', async () => {
    mockApiGetSequence([FULL_LEARNING, FULL_HEALTH, FULL_HEALTH]);
    renderWithQuery(<BrainDashboard />);
    expect(screen.getByText('Learning')).toBeTruthy();
    expect(screen.getByText('System Health')).toBeTruthy();
    fireEvent.click(screen.getByText('System Health'));
    await waitFor(() => {
      expect(screen.getByText('Phase 4 — Learned Heuristics')).toBeTruthy();
    });
  });

  it('switches to the Journey tab', async () => {
    mockApiGetSequence([
      FULL_LEARNING,
      { items: [{ id: 1, timestamp: '2026-08-03 10:00:00', sessionId: 'wb_1', eventSummary: 'User asked: fix CI', category: 'workbench' }], count: 1 },
    ]);
    renderWithQuery(<BrainDashboard />);
    fireEvent.click(screen.getByTestId('brain-tab-journey'));
    await waitFor(() => {
      expect(screen.getByText(/fix CI/)).toBeTruthy();
    });
  });
});