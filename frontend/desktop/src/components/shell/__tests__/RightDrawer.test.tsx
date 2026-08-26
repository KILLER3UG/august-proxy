import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RightDrawer } from '../RightDrawer';
import { RightDrawerDropdown } from '../RightDrawerLauncher';
import {
  isDrawerPanelVisible,
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

describe('RightDrawer section chooser (ZCode "Open tab")', () => {
  beforeEach(() => {
    $rightDrawer.set({ open: false, sections: [] });
  });

  function mountChooserDrawer() {
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

  it('renders the centered card grid with heading and every section', () => {
    act(() => {
      $rightDrawer.set({ open: true, sections: [], chooserActive: true });
    });
    mountChooserDrawer();
    const chooser = document.querySelector('[data-testid="drawer-section-chooser"]');
    expect(chooser).toBeTruthy();
    expect(screen.getByText('Open tab')).toBeTruthy();
    expect(screen.getByText('Choose a tab to open in the side pane.')).toBeTruthy();
    // Card grid offers the workbench sections…
    for (const label of ['Terminal (bottom)', 'Diffs', 'Notepad', 'Trajectory']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // …as cards (icon above label).
    const terminalCard = screen.getByText('Terminal (bottom)').closest('button');
    expect(terminalCard?.querySelector('svg')).toBeTruthy();
  });

  it('marks already-open sections and picking a card opens it, leaving the chooser', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      $rightDrawer.set({ open: true, sections: ['tasks'], chooserActive: true });
    });
    mountChooserDrawer();
    const chooser = document.querySelector('[data-testid="drawer-section-chooser"]')!;
    // Tasks card carries the open-check… (scoped to the chooser — the
    // already-open Tasks tab also carries that text in the strip)
    const tasksCard = Array.from(chooser.querySelectorAll('button')).find(
      (b) => b.textContent === 'Tasks',
    )!;
    expect(tasksCard.getAttribute('aria-selected')).toBe('true');
    // …picking Notepad opens it as a section and exits the chooser.
    fireEvent.click(Array.from(chooser.querySelectorAll('button')).find(
      (b) => b.textContent === 'Notepad',
    )!);
    expect(document.querySelector('[data-testid="drawer-tab-notes"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="drawer-section-chooser"]')).toBeNull();
  });

  it('Escape leaves the chooser without changing open sections', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      $rightDrawer.set({ open: true, sections: ['tasks'], chooserActive: true });
    });
    mountChooserDrawer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-testid="drawer-section-chooser"]')).toBeNull();
    expect(document.querySelector('[data-testid="drawer-tab-tasks"]')).toBeTruthy();
  });

  it('the titlebar panel icon opens the drawer into the chooser (no dropdown)', () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <RightDrawerDropdown
          drawerOpen={false}
          onSelect={() => {}}
          workersBadge={0}
        />
      </QueryClientProvider>,
    );
    // No dropdown markup before the click…
    expect(document.querySelector('[data-testid="launcher-section-list"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-testid="workbench-launcher"]')!);
    // …clicking the icon arms chooser mode + opens the drawer directly.
    const state = $rightDrawer.get();
    expect(state.open).toBe(true);
    expect(state.chooserActive).toBe(true);
  });

  it('chooser-only state counts as panel-visible for the layout shell', () => {
    // Regression guard for the ChatLayout sync gate: zero tabs + chooser must
    // keep the panel on screen (this exact combination hid it at ship).
    expect(isDrawerPanelVisible(true, 0, true)).toBe(true);
    expect(isDrawerPanelVisible(true, 0, undefined)).toBe(false);
    expect(isDrawerPanelVisible(true, 2, false)).toBe(true);
    expect(isDrawerPanelVisible(false, 2, true)).toBe(false);
  });
});

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

  it('shows ONLY the active section — tabs switch the single view', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      toggleRightDrawerSection('trajectory');
    });
    setupDrawer();
    // Two tabs exist but only ONE body renders — the active section's…
    expect(document.querySelectorAll('[data-testid="drawer-tab-tasks"]').length).toBe(1);
    expect(screen.getByText('Trajectory')).toBeTruthy();
    // …and the inactive tab's content is NOT stacked underneath.
    expect(document.querySelector('.august-drawer-card')).toBeNull();
    // Switching tabs swaps the entire body.
    fireEvent.click(document.querySelector('[data-testid="drawer-tab-tasks"]')!);
    expect(screen.getByTestId('right-drawer-tasks-root')).toBeTruthy();
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

  it('offers an inline + section picker listing only closed sections', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
      toggleRightDrawerSection('trajectory');
    });
    setupDrawer();
    const add = document.querySelector('[data-testid="drawer-tab-add"]');
    expect(add).toBeTruthy();
    fireEvent.click(add!);
    // The chooser takes over the drawer BODY (ZCode "Open tab" view)…
    const chooser = document.querySelector('[data-testid="drawer-section-chooser"]');
    expect(chooser).toBeTruthy();
    expect(screen.getByText('Open tab')).toBeTruthy();
    expect(screen.getByText('Choose a tab to open in the side pane.')).toBeTruthy();
    // …offers closed sections as cards…
    expect(screen.getByText('Notepad')).toBeTruthy();
    // Picking one opens it as a tab and leaves the chooser.
    fireEvent.click(screen.getByText('Notepad'));
    expect(document.querySelector('[data-testid="drawer-tab-notes"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="drawer-section-chooser"]')).toBeNull();
  });

  it('Escape leaves the chooser without changing open sections', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
    });
    setupDrawer();
    fireEvent.click(document.querySelector('[data-testid="drawer-tab-add"]')!);
    expect(document.querySelector('[data-testid="drawer-section-chooser"]')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-testid="drawer-section-chooser"]')).toBeNull();
    expect(document.querySelector('[data-testid="drawer-tab-tasks"]')).toBeTruthy();
  });

  it('single-section view renders flat without a nested card', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
    });
    setupDrawer();
    expect(
      document.querySelector('.august-drawer-card'),
    ).toBeNull();
  });

  it('defaults to the roomier Zed-like width (~420px)', () => {
    act(() => {
      toggleRightDrawerSection('tasks');
    });
    setupDrawer();
    const inner = document.querySelector<HTMLElement>('[data-testid="drawer-inner"]');
    expect(inner).toBeTruthy();
    expect(Number.parseInt(inner!.style.width, 10)).toBeGreaterThanOrEqual(400);
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
