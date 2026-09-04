import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelEffortMenu, chipModelLabel } from '../ModelEffortMenu';
import { providersApi } from '@/api/providers';
import type { ModelItem } from '../../model-display';

const MODELS: ModelItem[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'OpenCode Zen',
    contextWindow: 128000,
    isFree: true,
  },
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    provider: 'OpenCode Zen',
    contextWindow: 128000,
    isFree: false,
  },
  {
    id: 'ox-alpha',
    name: 'Ox Alpha',
    provider: 'KiloCode',
    contextWindow: 200000,
    isFree: false,
  },
  {
    id: 'ox-alpha-free',
    name: 'Ox Alpha Free',
    provider: 'KiloCode',
    contextWindow: 200000,
    isFree: true,
  },
];

function setup(selected: ModelItem | null = MODELS[2]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ModelEffortMenu
        models={MODELS}
        visibleModels={MODELS}
        loading={false}
        selected={selected}
        onSelect={() => {}}
        onEditModels={() => {}}
        effort="medium"
        onEffortChange={() => {}}
        thinkingEnabled={false}
        onThinkingChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

function openModelsPane() {
  fireEvent.click(document.querySelector('[data-testid="model-chip"]')!);
}

describe('ModelEffortMenu (provider-pane picker)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('chip label is Provider/model like the reference composer', () => {
    expect(chipModelLabel(MODELS[2])).toBe('KiloCode/ox-alpha');
    expect(chipModelLabel(null)).toBe('Model');
  });

  it('opens to a provider list; hovering a provider reveals its models in a flyout', () => {
    setup();
    openModelsPane();
    // Providers pane lists both providers…
    expect(document.querySelector('[data-testid="provider-row-OpenCode Zen"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="provider-row-KiloCode"]')).toBeTruthy();
    // …and the default flyout shows the SELECTED provider's models (KiloCode).
    expect(screen.getByText('ox-alpha-free')).toBeTruthy();
    expect(screen.queryByText('kimi-k3')).toBeNull();
    // Hover another provider → its models swap in.
    fireEvent.mouseEnter(document.querySelector('[data-testid="provider-row-OpenCode Zen"]')!);
    expect(screen.getByText('kimi-k3')).toBeTruthy();
    expect(screen.queryByText('ox-alpha-free')).toBeNull();
  });

  it('Manage models sits at the bottom of the provider pane', () => {
    setup();
    openModelsPane();
    expect(document.querySelector('[data-testid="manage-models"]')).toBeTruthy();
  });

  it('Refresh button sits at the top of the provider pane and triggers refreshAllModels', async () => {
    // Spy on the real providersApi so we can assert the mutation fires
    // without a network round-trip.
    const refreshSpy = vi
      .spyOn(providersApi, 'refreshAllModels')
      .mockResolvedValue({ refreshed: 0, failed: 0, added: 0, removed: 0 });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ModelEffortMenu
          models={MODELS}
          visibleModels={MODELS}
          loading={false}
          selected={MODELS[2]}
          onSelect={() => {}}
          onEditModels={() => {}}
          effort="medium"
          onEffortChange={() => {}}
          thinkingEnabled={false}
          onThinkingChange={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(document.querySelector('[data-testid="model-chip"]')!);
    const btn = document.querySelector('[data-testid="refresh-all-providers"]') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.title).toMatch(/Re-fetch/);
    fireEvent.click(btn);
    // The mutation is async; flush the microtask queue.
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    refreshSpy.mockRestore();
  });

  it('no free-only toggle and no search field — the calm reference layout', () => {
    setup();
    openModelsPane();
    expect(document.querySelector('[data-testid="free-only-toggle"]')).toBeNull();
    expect(screen.queryByPlaceholderText('Search models')).toBeNull();
  });

  it('pins stay available on model rows', () => {
    setup();
    openModelsPane();
    // Dropdown mounts through a portal on document.body
    const pins = document.body.querySelectorAll('button[title="Pin"], button[title="Unpin"]');
    expect(pins.length).toBeGreaterThan(0);
  });

  it('provider list and models flyout scroll internally when tall', () => {
    setup();
    openModelsPane();
    const list = document.querySelector('[data-testid="models-panel-list"]');
    expect(list).toBeTruthy();
    expect(list!.className).toContain('overflow-y-auto');
    const flyout = document.querySelector('[data-testid="provider-models-flyout"]');
    expect(flyout).toBeTruthy();
    expect(flyout!.className).toContain('overflow-y-auto');
  });

  it('roomy reference rows: 13px text with generous padding', () => {
    setup();
    openModelsPane();
    const row = document.querySelector('[data-testid="provider-row-KiloCode"]') as HTMLElement;
    expect(row.className).toContain('py-[7px]');
    expect(row.className).toContain('text-[13px]');
  });

  it('effort chip opens the effort pane with the list + thinking switch', () => {
    setup();
    fireEvent.click(document.querySelector('[data-testid="effort-chip"]')!);
    expect(document.querySelector('[data-testid="effort-menu"]')).toBeTruthy();
    expect(screen.getByText('Extended thinking')).toBeTruthy();
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="effort-option-Max"]')!);
    });
    // Pane stays open; selection is the parent's concern.
    expect(document.querySelector('[data-testid="effort-menu"]')).toBeTruthy();
  });

  it('clicking an effort option actually invokes onEffortChange (regression: outside-click was eating clicks)', () => {
    const onEffortChange = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ModelEffortMenu
          models={MODELS}
          visibleModels={MODELS}
          loading={false}
          selected={MODELS[2]}
          onSelect={() => {}}
          onEditModels={() => {}}
          effort="medium"
          onEffortChange={onEffortChange}
          thinkingEnabled={false}
          onThinkingChange={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(document.querySelector('[data-testid="effort-chip"]')!);
    fireEvent.click(document.querySelector('[data-testid="effort-option-High"]')!);
    expect(onEffortChange).toHaveBeenCalledWith('high');
  });

  it('clicking a model row in the flyout actually invokes onSelect (regression: outside-click was eating flyout clicks)', () => {
    const onSelect = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ModelEffortMenu
          models={MODELS}
          visibleModels={MODELS}
          loading={false}
          selected={MODELS[2]}
          onSelect={onSelect}
          onEditModels={() => {}}
          effort="medium"
          onEffortChange={() => {}}
          thinkingEnabled={false}
          onThinkingChange={() => {}}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(document.querySelector('[data-testid="model-chip"]')!);
    // Default flyout shows selected provider's models (KiloCode).
    const row = screen.getByText('ox-alpha-free').closest('[data-testid="model-option"]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ox-alpha-free', provider: 'KiloCode' }),
    );
  });

  it('effort options render as a vertical reference-style list with a check on the active row', () => {
    setup();
    fireEvent.click(document.querySelector('[data-testid="effort-chip"]')!);
    const menu = document.querySelector('[data-testid="effort-menu"]')!;
    for (const label of ['Low', 'Medium', 'High', 'Max']) {
      expect(
        menu.querySelector(`[data-testid="effort-option-${label}"]`),
      ).toBeTruthy();
    }
    // setup() selects effort="medium" — Medium carries the check, not Max.
    const medium = menu.querySelector('[data-testid="effort-option-Medium"]') as HTMLElement;
    expect(medium.getAttribute('aria-checked')).toBe('true');
    expect(medium.querySelector('svg')).toBeTruthy();
    const max = menu.querySelector('[data-testid="effort-option-Max"]') as HTMLElement;
    expect(max.getAttribute('aria-checked')).toBe('false');
    expect(medium.className).toContain('justify-between');
  });
});

describe('ModelEffortMenu dropdown anchoring (bottom-edge-hugs-chip)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** jsdom rects are all-zero; give the chips a realistic place to sit. */
  function placeChips(top: number, right: number) {
    for (const sel of ['[data-testid="model-chip"]', '[data-testid="effort-chip"]']) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`missing chip ${sel}`);
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + 32, left: right - 180, right, width: 180, height: 32,
           x: right - 180, y: top, toJSON: () => ({}) });
    }
  }

  it('models panel anchors by bottom edge just above the chip, not by reserving full height', () => {
    setup();
    placeChips(700, 900);
    openModelsPane();
    const panel = document.querySelector<HTMLElement>('[data-testid="model-effort-menu"]')!;
    expect(panel).toBeTruthy();
    // Old bug: style.top = chipTop − PANEL_H − 8 → deep inside the transcript.
    expect(panel.style.top).toBe('');
    // bottom: 8 gap between panel bottom edge (y=692) and chip top (700);
    // viewport is 768 tall → CSS bottom = 768 − 692 = 76.
    expect(panel.style.bottom).toBe('76px');
    // Height caps at the ideal size while there is room (700 − 16 > 380).
    expect(panel.style.maxHeight).toBe('380px');
  });

  it('short viewport above the chip shrinks the panel instead of overflowing', () => {
    setup();
    placeChips(48, 900); // chip near the very top
    openModelsPane();
    const panel = document.querySelector<HTMLElement>('[data-testid="model-effort-menu"]')!;
    // Only ~32px of room above the chip → minimum-height floor wins…
    expect(panel.style.maxHeight).toBe('96px');
    // …and the bottom clamp keeps the whole panel on-screen (below the top edge).
    expect(Number.parseFloat(panel.style.bottom)).toBeGreaterThanOrEqual(96);
  });

  it('effort pane uses the same bottom-edge anchoring', () => {
    setup();
    placeChips(600, 900);
    fireEvent.click(document.querySelector('[data-testid="effort-chip"]')!);
    const panel = document.querySelector<HTMLElement>('[data-testid="effort-menu"]')!;
    expect(panel).toBeTruthy();
    expect(panel.style.top).toBe('');
    // Panel bottom edge at y = 592 (chip top 600 − gap 8) → bottom = 768 − 592.
    expect(panel.style.bottom).toBe('176px');
  });
});
