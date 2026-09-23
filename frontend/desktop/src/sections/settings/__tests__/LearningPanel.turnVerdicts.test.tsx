/* ── LearningPanel: turn verdicts (046) ────────────────────────────────── */
/* The panel now reads the persisted turn verdict — why the managed tool loop
 * stopped, plus the self-correction counters — from
 * `GET /api/brain/turn-outcomes`. Two promises this file pins:
 *   1. an unmeasured value renders "not recorded", never a clean-looking 0;
 *   2. the block is a read-out of finished turns — it implies no gate. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

import { api } from '@/api/client';
import { LearningPanel } from '../LearningPanel';

const getMock = vi.mocked(api.get);

const VERDICTS = {
  days: 7,
  turns: 12,
  reasons: [
    { reason: 'finished', turns: 7 },
    { reason: 'length', turns: 3 },
    { reason: 'stall-stop', turns: 2 },
  ],
  reasonUnrecorded: 4,
  counters: {
    rounds: { avg: 3.4, max: 11, measured: 8, unrecorded: 4 },
    // total 0 = measured and clean; total null = never measured. The panel
    // must render those two differently.
    malformedToolArgs: { total: 0, measured: 8, turns: 0, unrecorded: 4 },
    surfaceDowngrades: { total: null, measured: 0, turns: 0, unrecorded: 12 },
    editVerifyFails: { total: 5, measured: 9, turns: 2, unrecorded: 3 },
    guardrailBlocks: {
      total: 6,
      measured: 10,
      turns: 3,
      unrecorded: 2,
      byTool: [
        { tool: 'edit_file', blocks: 4 },
        { tool: 'run_command', blocks: 2 },
      ],
    },
  },
};

function mockVerdicts(payload: unknown) {
  getMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/models')) {
      return Promise.resolve({ models: [] });
    }
    if (url.startsWith('/api/brain/turn-outcomes')) {
      return Promise.resolve(payload);
    }
    return Promise.resolve({
      mode: 'extract-only',
      learning: { episodes: 1 },
      proposals: [],
      episodes: [],
      jobs: [],
      runs: [],
    });
  });
}

const renderExpanded = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LearningPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('Learning'));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('turn verdicts block', () => {
  it('shows the reason distribution with plain-language labels', async () => {
    mockVerdicts({ days: 7, models: [], verdicts: VERDICTS });
    renderExpanded();
    const finished = await screen.findByTestId('learning-verdict-finished');
    expect(finished.textContent).toContain('answered');
    expect(finished.textContent).toContain('7');
    expect(screen.getByTestId('learning-verdict-length').textContent).toContain('hit output limit');
    expect(screen.getByTestId('learning-verdict-stall-stop').textContent).toContain('stalled');
    // The raw token stays one hover away, so the label never drifts from the data.
    expect(screen.getByTestId('learning-verdict-length').getAttribute('title')).toContain(
      'end_reason = length',
    );
  });

  it('labels rows whose verdict was never recorded instead of folding them in', async () => {
    mockVerdicts({ days: 7, models: [], verdicts: VERDICTS });
    renderExpanded();
    const chip = await screen.findByTestId('learning-verdict-unrecorded');
    expect(chip.textContent).toContain('4');
    expect(chip.textContent).toMatch(/not recorded/);
  });

  it('renders a measured zero as a zero and an unmeasured total as not recorded', async () => {
    mockVerdicts({ days: 7, models: [], verdicts: VERDICTS });
    renderExpanded();
    const malformed = await screen.findByTestId(
      'learning-verdict-counter-malformed-tool-args',
    );
    expect(malformed.textContent).toContain('0');
    expect(malformed.textContent).not.toMatch(/not recorded\s*·\s*not recorded/);
    const downgrades = screen.getByTestId('learning-verdict-counter-tool-surface-downgrades');
    expect(downgrades.textContent).toMatch(/not recorded/);
    expect(downgrades.textContent).not.toMatch(/\b0\b/);
    // The tool-attributed counters read out their numbers and their hot spots.
    const guardrail = screen.getByTestId('learning-verdict-counter-guardrail-blocks');
    expect(guardrail.textContent).toContain('6');
    expect(guardrail.textContent).toContain('edit_file 4');
    expect(screen.getByTestId('learning-verdict-counter-edit-verification-misses').textContent).toContain('5');
  });

  it('says rounds are unmeasured when the window has no measured row', async () => {
    mockVerdicts({
      days: 7,
      models: [],
      verdicts: { ...VERDICTS, counters: { ...VERDICTS.counters, rounds: { avg: null, max: null, measured: 0, unrecorded: 12 } } },
    });
    renderExpanded();
    const rounds = await screen.findByTestId('learning-verdict-counter-rounds');
    expect(rounds.textContent).toMatch(/not recorded/);
    expect(rounds.textContent).not.toMatch(/avg/);
  });

  it('states that this is a read-out of finished turns, not a gate', async () => {
    mockVerdicts({ days: 7, models: [], verdicts: VERDICTS });
    renderExpanded();
    const note = await screen.findByTestId('learning-verdict-no-gate');
    expect(note.textContent).toMatch(/nothing here gates/i);
    expect(note.textContent).toMatch(/answer/i);
  });

  it('shows an honest empty state when nothing has been recorded', async () => {
    mockVerdicts({ days: 7, models: [], verdicts: { days: 7, turns: 0, reasons: [], reasonUnrecorded: 0, counters: {} } });
    renderExpanded();
    expect(await screen.findByText(/No turns recorded in this window/)).toBeInTheDocument();
    expect(screen.queryByTestId('learning-verdict-finished')).toBeNull();
  });
});
