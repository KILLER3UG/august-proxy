/* v3 — Brain dashboard LearningTab + SystemHealthTab */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { BrainDashboard } from '@/sections/brain/BrainDashboard';

function mockFetchSequence(responses: Array<unknown>) {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    const data = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve({ ok: true, json: () => data });
  });
}

const FULL_LEARNING = {
  heuristics: [
    { id: 1, rule: 'Use Yarn', source: 'manual', category: 'build', createdAt: '2026-06-29' },
    { id: 2, rule: 'Prefer tabs', source: 'local-diff', category: 'style', createdAt: '2026-06-29' },
  ],
  heuristicCount: 2,
  coreFacts: { codeStyle: 'spaces' },
  userProfile: null,
  autoMemories: [{ id: 1, key: 'jwt-fix', content: 'JWT expiry bug', importance: 0.8 }],
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
    global.fetch = mockFetchSequence([FULL_LEARNING]);
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('Use Yarn')).toBeTruthy();
      expect(screen.getByText('manual')).toBeTruthy();
      expect(screen.getByText('local-diff')).toBeTruthy();
    });
  });

  it('renders auto-memories', async () => {
    global.fetch = mockFetchSequence([FULL_LEARNING]);
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/JWT expiry bug/)).toBeTruthy();
    });
  });

  it('renders sleep cycle stats', async () => {
    global.fetch = mockFetchSequence([FULL_LEARNING]);
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText(/Last run/)).toBeTruthy();
      expect(screen.getByText(/2 merges/)).toBeTruthy();
    });
  });

  it('renders pending skills', async () => {
    global.fetch = mockFetchSequence([FULL_LEARNING]);
    render(<LearningTab />);
    await waitFor(() => {
      expect(screen.getByText('jwtDebugFlow')).toBeTruthy();
    });
  });
});

describe('v3 — SystemHealthTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a layer row with detail', async () => {
    global.fetch = mockFetchSequence([FULL_HEALTH]);
    render(<SystemHealthTab />);
    await waitFor(() => {
      expect(screen.getByText('Phase 4 — Learned Heuristics')).toBeTruthy();
      expect(screen.getByText('on & healthy')).toBeTruthy();
      expect(screen.getByText('12 active heuristics')).toBeTruthy();
    });
  });

  it('shows failing detail when a layer is failing', async () => {
    global.fetch = mockFetchSequence([FULL_HEALTH]);
    render(<SystemHealthTab />);
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
    global.fetch = mockFetchSequence([FULL_LEARNING, FULL_HEALTH, FULL_HEALTH]);
    render(<BrainDashboard />);
    expect(screen.getByText('Learning')).toBeTruthy();
    expect(screen.getByText('System Health')).toBeTruthy();
    fireEvent.click(screen.getByText('System Health'));
    await waitFor(() => {
      expect(screen.getByText('Phase 4 — Learned Heuristics')).toBeTruthy();
    });
  });
});