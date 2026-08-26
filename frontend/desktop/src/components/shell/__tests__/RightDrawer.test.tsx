import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RightDrawer } from '../RightDrawer';
import {
  toggleRightDrawerSection,
  $rightDrawer,
} from '../RightDrawerState';
import { RightDrawerTrajectorySection } from '../RightDrawerTrajectorySection';
import * as harness from '@/api/harness';
import type { HarnessTrace } from '@/api/harness';

vi.mock('@/api/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/harness')>();
  return { ...actual, listSessionTraces: vi.fn() };
});

function setupDrawer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RightDrawer
        open
        sessionId="sess_tab"
        workspacePath={null}
        workbenchSession={null}
        onApprovePlan={async () => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('RightDrawer tab-strip header (Zed-style)', () => {
  beforeEach(() => {
    $rightDrawer.set({ open: false, sections: [] });
  });

  it('renders one tab per open section with icon, label and a close button', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      toggleRightDrawerSection('trajectory');
    });
    setupDrawer();
    const strip = document.querySelector('[data-testid="drawer-tab-strip"]');
    expect(strip).toBeTruthy();
    const tabs = document.querySelectorAll('[data-testid^="drawer-tab-"][role="tab"]');
    expect(tabs.length).toBe(2);
    expect(screen.getByText('Tasks')).toBeTruthy();
    expect(screen.getByText('Trajectory')).toBeTruthy();
    // Per-tab close affordance…
    expect(
      document.querySelector('[data-testid="drawer-tab-close-trajectory"]'),
    ).toBeTruthy();
    // …and the plain "Workbench" title is replaced by the tabs.
    expect(screen.queryByText('Workbench')).toBeNull();
  });

  it('clicking a tab makes it the active section', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      toggleRightDrawerSection('trajectory');
    });
    setupDrawer();
    // The most recently opened section (trajectory) starts active.
    const trajectoryTab = document.querySelector(
      '[data-testid="drawer-tab-trajectory"]',
    ) as HTMLElement;
    expect(trajectoryTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(document.querySelector('[data-testid="drawer-tab-tasks"]')!);
    expect(
      document
        .querySelector('[data-testid="drawer-tab-tasks"]')!
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(trajectoryTab.getAttribute('aria-selected')).toBe('false');
  });

  it('closing a tab via its ✕ removes just that section', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      toggleRightDrawerSection('notes');
    });
    setupDrawer();
    fireEvent.click(document.querySelector('[data-testid="drawer-tab-close-notes"]')!);
    expect(document.querySelector('[data-testid="drawer-tab-notes"]')).toBeNull();
    expect(document.querySelector('[data-testid="drawer-tab-tasks"]')).toBeTruthy();
  });

  it('file preview mode keeps the filename header, not tabs', () => {
    act(() => {
      $rightDrawer.set({
        open: true,
        sections: ['file'],
        activeSection: 'file',
        file: { name: 'report.pdf', size: '1 KB', type: 'unsupported' },
      });
    });
    setupDrawer();
    expect(document.querySelector('[data-testid="drawer-tab-strip"]')).toBeNull();
    expect(screen.getAllByText('report.pdf').length).toBeGreaterThan(0);
  });
});

const TRACE: HarnessTrace = {
  id: 41,
  turn_seq: 7,
  outcome: 'ok',
  model: 'deepseek-v4-flash',
  provider: 'OpenCode Zen',
  duration_ms: 2300,
  input_tokens: 1200,
  output_tokens: 210,
  rounds: 4,
  prompt_preview: 'fix the flaky test',
  tool_calls: ['terminal', 'read_file'],
  evidence_state: '',
  self_heal_events: {},
  error: null,
} as unknown as HarnessTrace;

describe('RightDrawerTrajectorySection activity-log rows', () => {
  beforeEach(() => {
    vi.mocked(harness.listSessionTraces).mockReset();
  });

  function mountWith(traces: HarnessTrace[]) {
    vi.mocked(harness.listSessionTraces).mockResolvedValue(traces);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <RightDrawerTrajectorySection sessionId="sess_tab" />
      </QueryClientProvider>,
    );
  }

  it('renders each turn as a single icon·label·meta activity row', async () => {
    mountWith([TRACE]);
    const row = await screen.findByTestId('trajectory-row-41');
    // One leading outcome icon (the log glyph)…
    expect(row.querySelector('svg')).toBeTruthy();
    // …a human label…
    expect(row.textContent).toContain('Turn 7');
    // …and trailing meta: rounds + duration.
    expect(row.textContent).toContain('4 rounds');
    expect(row.textContent).toContain('2.3s');
    // Tool chips stay available.
    expect(row.textContent).toContain('terminal');
  });

  it('keeps self-heal chips and error lines on the compact row', async () => {
    mountWith([
      {
        ...TRACE,
        id: 42,
        outcome: 'error',
        error: 'upstream 500',
        self_heal_events: { parse_failures: 2 } as HarnessTrace['self_heal_events'],
      },
    ]);
    const row = await screen.findByTestId('trajectory-row-42');
    expect(row.textContent).toContain('parse ×2');
    expect(row.textContent).toContain('upstream 500');
  });

  it('shows a live marker on a turn that has no outcome yet', async () => {
    mountWith([{ ...TRACE, id: 43, outcome: '' }]);
    const row = await screen.findByTestId('trajectory-row-43');
    expect(row.querySelector('[data-testid="trajectory-live"]')).toBeTruthy();
  });
});
