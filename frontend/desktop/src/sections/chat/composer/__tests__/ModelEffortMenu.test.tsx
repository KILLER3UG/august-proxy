import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
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

function setup(selected: ModelItem | null = MODELS[2], list: ModelItem[] = MODELS) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ModelEffortMenu
        models={list}
        visibleModels={list}
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

/** The flyout is remounted on every provider hover, so re-query it each time. */
function flyout(): HTMLElement {
  const el = document.querySelector('[data-testid="provider-models-flyout"]');
  if (!el) throw new Error('model flyout is not open');
  return el as HTMLElement;
}

/** Rows are located by the `provider/id` tooltip the label deliberately hides. */
function modelRow(provider: string, id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="model-option"][title="${provider}/${id}"]`,
  );
}

function openModelsPane() {
  fireEvent.click(document.querySelector('[data-testid="model-chip"]')!);
}

describe('ModelEffortMenu (provider-pane picker)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('chip label is Provider · friendly name, never a truncated id', () => {
    // Was `KiloCode/ox-alpha`, documented as "matching the reference composer".
    // An identifier truncated at 34 characters is not a label: the chip read
    // "KiloCode/ox-alpha-free" → "KiloCode/ox-alp…" while the list under it said
    // "Ox Alpha Free". The exact id lives in the tooltip now.
    expect(chipModelLabel(MODELS[2])).toBe('KiloCode · Ox Alpha');
    expect(chipModelLabel(MODELS[3])).toBe('KiloCode · Ox Alpha Free');
    expect(chipModelLabel(null)).toBe('Model');
    // The 34-character ceiling still binds, it just no longer cuts an id in
    // half on the way — a long catalog name is truncated instead.
    const long = chipModelLabel({ ...MODELS[0], name: 'DeepSeek V4 Flash Instruct Reasoner Plus' });
    expect(long).toBe('OpenCode Zen · DeepSeek V4 Flash…');
    expect(long.length).toBe(33);
    expect(long.endsWith('…')).toBe(true);
  });

  it('opens to a provider list; hovering a provider reveals its models in a flyout', () => {
    setup();
    openModelsPane();
    // Providers pane lists both providers…
    expect(document.querySelector('[data-testid="provider-row-OpenCode Zen"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="provider-row-KiloCode"]')).toBeTruthy();
    // …and the default flyout shows the SELECTED provider's models (KiloCode).
    // Rows carry the catalog's friendly name (variant folded into it, since the
    // provider supplied the whole label). These asserted the raw ids
    // (`ox-alpha-free`, `kimi-k3`) until 2026-10-07, which pinned the defect of
    // listing identifiers right under a header that said "Ox Alpha".
    expect(within(flyout()).getByText('Ox Alpha')).toBeTruthy();
    expect(within(flyout()).getByText('Ox Alpha Free')).toBeTruthy();
    expect(within(flyout()).queryByText('Kimi K3')).toBeNull();
    // Hover another provider → its models swap in.
    fireEvent.mouseEnter(document.querySelector('[data-testid="provider-row-OpenCode Zen"]')!);
    expect(within(flyout()).getByText('Kimi K3')).toBeTruthy();
    expect(within(flyout()).queryByText(/Ox Alpha/)).toBeNull();
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

  // Contract changed 2026-10-04: this asserted "no search field — the calm
  // reference layout". With 466 models across 5 providers the two-level
  // provider→flyout layout cannot reach a model by name, so search was asked
  // for. The free-only toggle stays banned; search is now required.
  it('no free-only toggle, but a working model search field', () => {
    setup();
    openModelsPane();
    expect(document.querySelector('[data-testid="free-only-toggle"]')).toBeNull();

    const search = screen.getByPlaceholderText('Search models');
    expect(search).toBeTruthy();

    // A miss says so in words instead of silently showing an empty list.
    fireEvent.change(search, { target: { value: 'no-such-model-xyz' } });
    expect(document.body.textContent).toContain('No model matches');

    // Clearing restores the provider list.
    fireEvent.change(search, { target: { value: '' } });
    expect(document.body.textContent).not.toContain('No model matches');
    expect(document.querySelectorAll('[data-testid^="provider-row-"]').length).toBeGreaterThan(0);
  });

  it('also matches the prettified id, so a space-typed query reaches a catalog with no names', () => {
    const list: ModelItem[] = [
      ...MODELS,
      // What `useChatModels` produces for a catalog that sends no display name:
      // name falls back to the id, so only the prettified name + variant tag
      // can match "ox beta preview" — the hyphenated id cannot.
      {
        id: 'ox-beta-preview',
        name: 'ox-beta-preview',
        provider: 'KiloCode',
        contextWindow: 200000,
      },
      // A family prefix: prettifyBase drops "claude" from the NAME, so this only
      // matches "claude sonnet" because the id itself is in the haystack.
      {
        id: 'anthropic/claude-sonnet-4-5',
        name: 'anthropic/claude-sonnet-4-5',
        provider: 'Anthropic',
        contextWindow: 200000,
      },
    ];
    setup(list[0], list);
    openModelsPane();
    const search = screen.getByPlaceholderText('Search models');

    fireEvent.change(search, { target: { value: 'ox beta preview' } });
    const previewRow = modelRow('KiloCode', 'ox-beta-preview');
    expect(previewRow).toBeTruthy();
    expect(within(previewRow as HTMLElement).getByText('Ox Beta')).toBeTruthy();
    expect(within(previewRow as HTMLElement).getByText('Preview')).toBeTruthy();
    expect(previewRow!.textContent).not.toContain('ox-beta-preview');

    fireEvent.change(search, { target: { value: 'claude sonnet' } });
    const sonnetRow = modelRow('Anthropic', 'anthropic/claude-sonnet-4-5');
    expect(sonnetRow).toBeTruthy();
    // The provider is the row's own badge in search mode — repeating it as the
    // id-prefix tag put "Anthropic" under "Anthropic". So exactly ONE element in
    // this row says the provider, not two.
    expect(sonnetRow!.textContent).toContain('Sonnet 4 5');
    expect(within(sonnetRow as HTMLElement).getAllByText(/^anthropic$/i)).toHaveLength(1);
  });

  it('renders a colon-tier id as a name plus a tier, never "Laguna S 2.1:Free"', () => {
    // KiloCode/OpenRouter ship ids like `poolside/laguna-s-2.1:free`, and the
    // catalog sends no display name — so this is the common case, not an edge.
    const list: ModelItem[] = [
      {
        id: 'poolside/laguna-s-2.1:free',
        name: 'poolside/laguna-s-2.1:free',
        provider: 'KiloCode',
        contextWindow: 128000,
        isFree: true,
      },
    ];
    setup(list[0], list);
    openModelsPane();
    const row = modelRow('KiloCode', 'poolside/laguna-s-2.1:free');
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).getByText('Laguna S 2.1')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('poolside:Free')).toBeTruthy();
    expect(row!.textContent).not.toContain('Laguna S 2.1:Free');
    // The chip keeps the tier and drops the vendor slug, which the panel header
    // already says.
    expect(chipModelLabel(list[0])).toBe('KiloCode · Laguna S 2.1 (Free)');
  });

  it('says what the search result cap dropped instead of silently cutting the list', () => {
    const bulk: ModelItem[] = Array.from({ length: 90 }, (_, i) => ({
      id: `bulk-model-${i}`,
      name: `bulk-model-${i}`,
      provider: 'Bulk',
      contextWindow: 128000,
    }));
    setup(bulk[0], bulk);
    openModelsPane();
    fireEvent.change(screen.getByPlaceholderText('Search models'), { target: { value: 'bulk' } });
    // Scoped to the list: the flyout the search replaced is still mid-exit
    // animation in jsdom, so its rows are on the body but not in this panel.
    const list = document.querySelector<HTMLElement>('[data-testid="models-panel-list"]')!;
    expect(list.querySelectorAll('[data-testid="model-option"]')).toHaveLength(80);
    expect(list.textContent).toContain('10 more match');
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

  it('roomy reference rows: 15px text with generous padding', () => {
    setup();
    openModelsPane();
    const row = document.querySelector('[data-testid="provider-row-KiloCode"]') as HTMLElement;
    expect(row.className).toContain('py-[10px]');
    expect(row.className).toContain('text-[0.9375rem]');
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
    const row = modelRow('KiloCode', 'ox-alpha-free');
    expect(row).toBeTruthy();
    // Rows carry the friendly name; the raw id survives only in the tooltip.
    expect(row!.textContent).toContain('Ox Alpha');
    expect(row!.textContent).not.toContain('ox-alpha-free');
    fireEvent.click(row!);
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
    // Height caps at the ideal size while there is room (700 − 16 > 420).
    expect(panel.style.maxHeight).toBe('420px');
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

describe('ModelEffortMenu — keyboard navigation', () => {
  const openModels = () => {
    setup();
    placeChips(600, 900);
    fireEvent.click(document.querySelector('[data-testid="model-chip"]')!);
    return document.querySelector<HTMLElement>('[data-testid="model-effort-menu"]')!;
  };

  it('focuses the panel when it opens, so arrow keys have a target', () => {
    const panel = openModels();
    expect(document.activeElement).toBe(panel);
  });

  it('clears the query on the first Escape and closes on the second', () => {
    // "One layer per press" is the input's own stopPropagation. If it ever
    // stops holding, a single Escape both empties the field and shuts the pane.
    // Asserted on the trigger's aria-expanded because an exiting portal keeps
    // its DOM nodes while framer-motion finishes, which jsdom never resolves.
    openModels();
    const chip = document.querySelector('[data-testid="model-chip"]')!;
    const search = document.querySelector<HTMLInputElement>('[data-testid="model-search"]')!;
    fireEvent.change(search, { target: { value: 'kimi' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not steal the caret while the search field has focus', () => {
    // The input sits inside the panel that owns ArrowUp/Down/Home/End. Without
    // a guard on that handler, one arrow press preventDefault()ed the caret move
    // and threw focus at the panel's first control — so a keyboard user could
    // not edit the query they were typing.
    openModels();
    const search = document.querySelector<HTMLInputElement>('[data-testid="model-search"]')!;
    search.focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      fireEvent.keyDown(search, { key });
      expect(document.activeElement).toBe(search);
    }
  });

  it('mounting does not yank focus out of the composer', () => {
    // Regression: the focus effect also runs on mount with `pane === null`,
    // where its "restore" branch put focus on the model chip — leaving the
    // textarea without initial focus on every fresh composer.
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    setup();

    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  /** Mirrors the component's own visibility rule: style-based, because these
   *  panels are fixed-position portals and jsdom reports no client rects. */
  const focusables = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].filter((el) => {
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

  it('ArrowDown/ArrowUp move a roving focus between the panel controls', () => {
    const panel = openModels();
    const items = focusables(panel);
    expect(items.length).toBeGreaterThan(2);

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    const first = document.activeElement as HTMLElement;
    expect(panel.contains(first)).toBe(true);
    expect(first).toBe(items[0]);

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(panel.contains(second)).toBe(true);

    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('wraps at both ends instead of dropping focus to the body', () => {
    const panel = openModels();
    const items = focusables(panel);

    fireEvent.keyDown(panel, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    expect(document.body).not.toBe(document.activeElement);
    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('skips controls that are hidden', () => {
    const panel = openModels();
    const items = focusables(panel);
    const hidden = items[0];
    hidden.setAttribute('hidden', '');

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(hidden);
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('Escape closes the menu and returns focus to the chip that opened it', () => {
    const panel = openModels();
    const chip = document.querySelector<HTMLElement>('[data-testid="model-chip"]')!;
    fireEvent.keyDown(panel, { key: 'Escape' });
    // Nodes can survive the exit animation, so assert collapsed state, not
    // DOM absence.
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
  });

  it('the effort pane is navigable too', () => {
    setup();
    placeChips(600, 900);
    fireEvent.click(document.querySelector('[data-testid="effort-chip"]')!);
    // The effort panel carries no test id of its own, so locate it the same
    // way the component does: the container holding the effort options.
    const option = document.querySelector<HTMLElement>('[role="menuitemradio"]')!;
    expect(option).toBeTruthy();
    const panel = option.closest('div[tabindex="-1"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
  });
});
